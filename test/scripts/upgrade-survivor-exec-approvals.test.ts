import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readJson, runProcess, writeJson } from "./upgrade-survivor-shard.test-support.js";

const assertions = resolve("scripts/e2e/lib/upgrade-survivor/assertions.mjs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Independent persisted output contract: v2026.7.1-2's authored policy, with
// only historical null usage removed by the frozen candidate's Doctor importer.
function canonicalPolicy() {
  const rules = (security: string, ask: string, autoAllowSkills: boolean) => ({
    security,
    ask,
    askFallback: "deny",
    autoAllowSkills,
  });
  return {
    version: 1,
    socket: { path: "/synthetic/exec.sock", token: "synthetic-socket-value-must-not-be-logged" },
    defaults: rules("allowlist", "on-miss", false),
    agents: {
      main: {
        ...rules("allowlist", "always", true),
        allowlist: [
          {
            id: "survivor-unused-command",
            pattern: "/opt/upgrade-survivor/bin/report",
            argPattern: "--summary",
          },
          {
            id: "survivor-used-command",
            pattern: "/opt/upgrade-survivor/bin/check",
            lastUsedAt: 1782864000000,
            lastUsedCommand: "/opt/upgrade-survivor/bin/check --synthetic",
            lastResolvedPath: "/opt/upgrade-survivor/bin/check",
          },
        ],
      },
      auditor: {
        ...rules("deny", "off", false),
        allowlist: [{ id: "survivor-auditor-command", pattern: "/opt/upgrade-survivor/bin/audit" }],
      },
    },
  };
}

function policyHarness(scenario: string) {
  const home = tempDirs.make("survivor-exec-policy-");
  const state = join(home, "state");
  const artifactRoot = join(home, "artifacts");
  const legacyPath = join(state, "exec-approvals.json");
  const dbPath = join(state, "state", "openclaw.sqlite");
  const env = {
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"),
    OPENCLAW_TEST_WORKSPACE_DIR: join(home, "workspace"),
    OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: scenario,
    OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifactRoot,
  };
  const run = (command: string, stage = "survival") =>
    runProcess(
      process.execPath,
      [assertions, command],
      { ...env, OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE: stage },
      10_000,
    );
  function writeCanonical(raw: string | null) {
    mkdirSync(join(state, "state"), { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(
        "CREATE TABLE exec_approvals_config (config_key TEXT PRIMARY KEY, raw_json TEXT NOT NULL)",
      );
      if (raw !== null) {
        db.prepare("INSERT INTO exec_approvals_config VALUES (?, ?)").run("current", raw);
      }
    } finally {
      db.close();
    }
  }
  function observe(stage = "survival") {
    const before = existsSync(dbPath) ? readFileSync(dbPath) : null;
    const result = run("assert-exec-approvals", stage);
    expect(existsSync(dbPath) ? readFileSync(dbPath) : null).toEqual(before);
    for (const privateValue of [
      "synthetic-socket-value-must-not-be-logged",
      "/opt/upgrade-survivor/bin",
      "private-runtime-socket-token",
    ]) {
      expect(result.stdout + result.stderr).not.toContain(privateValue);
    }
    return result;
  }
  return { run, state, artifactRoot, legacyPath, writeCanonical, observe };
}

function fixture() {
  const harness = policyHarness("base");
  const seeded = harness.run("seed");
  expect(seeded.status, seeded.stderr).toBe(0);
  const legacyBytes = readFileSync(harness.legacyPath);
  const observe = () => {
    const entries = readdirSync(harness.state, { recursive: true });
    const result = harness.observe();
    expect(readFileSync(harness.legacyPath)).toEqual(legacyBytes);
    expect(readdirSync(harness.state, { recursive: true })).toEqual(entries);
    return result;
  };
  return { ...harness, legacyBytes, observe };
}

it("seeds the populated tagged policy with historical null usage", () => {
  const { run, legacyBytes } = fixture();
  const expected = canonicalPolicy();
  const { socket: _socket, ...legacy } = expected;
  Object.assign(legacy.agents.main.allowlist[0]!, { lastUsedAt: null, lastUsedCommand: null });
  expect(JSON.parse(legacyBytes.toString())).toEqual(legacy);
  const result = run("assert-exec-approvals", "baseline");
  expect(result.status, result.stderr).toBe(0);
});

it.each([
  ["database", /missing after update/],
  ["row", /missing after update/],
  ["defaults", /exec approval.*changed/],
  ["agent policy", /exec approval.*changed/],
  ["malformed", /exec approval policy is not valid JSON/],
] as const)("rejects canonical %s without repairing or leaking it", (kind, error) => {
  const { writeCanonical, observe } = fixture();
  if (kind === "row") {
    writeCanonical(null);
  } else if (kind === "malformed") {
    writeCanonical("synthetic-socket-value-must-not-be-logged {");
  } else if (kind !== "database") {
    const policy = canonicalPolicy();
    if (kind === "defaults") {
      policy.defaults.security = "full";
    } else {
      policy.agents.auditor.ask = "always";
    }
    writeCanonical(JSON.stringify(policy));
  }
  const result = observe();
  expect(result).toMatchObject({ status: 1, stderr: expect.stringMatching(error) });
});

function approvalFixture() {
  const harness = policyHarness("legacy-operator-state");
  const policy = {
    version: 1,
    defaults: { security: "allowlist", ask: "off", askFallback: "deny" },
    agents: {
      main: { allowlist: [{ id: "main-command", pattern: "/usr/bin/uname" }] },
      ops: { allowlist: [{ id: "ops-command", pattern: "/usr/bin/date" }] },
    },
  };
  mkdirSync(harness.artifactRoot);
  mkdirSync(harness.state);
  writeJson(join(harness.artifactRoot, "legacy-operator-baseline.json"), {
    approvals: policy,
    approvalsJsonEra: true,
  });
  return {
    policy,
    legacyPath: harness.legacyPath,
    writeCanonical: (value: unknown) => harness.writeCanonical(JSON.stringify(value)),
    run: harness.observe,
  };
}

it("accepts baseline JSON but rejects the retained file after SQLite import", () => {
  const { policy, legacyPath, writeCanonical, run } = approvalFixture();
  writeJson(legacyPath, policy);
  const baseline = run("baseline");
  expect(baseline.status, baseline.stderr).toBe(0);
  // The real importer owns retirement. This independent fixture supplies its output.
  writeCanonical({ ...policy, socket: { token: "private-runtime-socket-token" } });
  const retainedLegacy = run();
  expect(retainedLegacy.status).toBe(1);
  expect(retainedLegacy.stderr).toContain("legacy exec approvals file was not retired");
});

it.each(["altered mode", "missing storage"])("rejects legacy %s without repair", (failure) => {
  const { policy, legacyPath, writeCanonical, run } = approvalFixture();
  if (failure === "altered mode") {
    policy.defaults.security = "full";
    writeCanonical(policy);
  } else {
    writeJson(legacyPath, policy);
  }
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    failure === "altered mode"
      ? "legacy operator exec approvals changed"
      : "legacy operator approvals database missing",
  );
  if (failure === "missing storage") {
    expect(readJson(legacyPath)).toEqual(policy);
  }
});
