// Qualification of the package Codex harness public audit inspection boundary.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCodexAudit } from "../../scripts/e2e/lib/codex-npm-plugin-live/audit-inspection.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const CODEX_NPM_PLUGIN_LIVE_ASSERTIONS_SCRIPT =
  "scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs";
const auditTempDirs = useAutoCleanupTempDirTracker(afterEach);

function runAssertions(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CODEX_NPM_PLUGIN_LIVE_ASSERTIONS_SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: path.join(root, "home"),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--disable-warning=ExperimentalWarning"]
        .filter(Boolean)
        .join(" "),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      ...env,
    },
  });
}

function codexAuditFixture() {
  const hmac = (value: string) => `hmac-sha256:v1:${"a".repeat(32)}:${value.repeat(64)}`;
  const domainRef = hmac("b");
  const selectors = [1, 2, 3].map((index) => ({
    runId: `codex-run-${index}`,
    executionId: `codex-execution-${index}`,
    contextId: `codex-context-${index}`,
  }));
  const results = selectors.map((selector) => ({
    schemaVersion: 1,
    run: { runId: selector.runId, executionId: selector.executionId, status: "known" },
    identity: {
      state: "present",
      context: {
        ...selector,
        trustDomain: { kind: "gateway-cell", domainRef, state: "present" },
        invoker: { state: "absent" },
        ingress: { kind: "local-cli", state: "present" },
        agentPrincipal: { kind: "agent", domainRef, principalRef: "main" },
        agentDefinition: { definitionRef: "main", state: "present" },
        runtimeInstance: { kind: "plugin-harness", runtimeRef: hmac("c"), state: "present" },
        applicableGrants: [],
        assurance: [
          {
            kind: "runtime-binding",
            evidenceRef: hmac("d"),
            strength: "boundary-verified",
          },
        ],
        coverageState: "unattributed",
      },
    },
    decisionDisplays: [
      {
        action: { family: "run", operation: "admission" },
        decision: {
          outcome: "not-applicable",
          reasonCode: "run_admission_identity_not_evaluated",
        },
        enforcement: {
          coverageState: "unattributed",
          grantCount: 0,
          policyCount: 0,
        },
        provenance: { state: "verified", producer: "run-admission" },
      },
    ],
  }));
  const replies = new Map<string, (typeof results)[number]>();
  for (const result of results) {
    replies.set(`--run ${result.run.runId} --explain --limit 50`, structuredClone(result));
    replies.set(`--execution ${result.run.executionId} --explain --limit 100`, result);
  }
  const exact = results[0]!;
  return {
    selectors,
    replies,
    targets: {
      identity: exact.identity,
      context: exact.identity.context,
      runtime: exact.identity.context.runtimeInstance,
      enforcement: exact.decisionDisplays[0]!.enforcement,
      action: exact.decisionDisplays[0]!.action,
      exact,
    },
  };
}

describe("Codex package audit qualification", () => {
  it.each([
    ["identity", { state: "unsupported" }],
    ["context", { runId: "another-run" }],
    ["context", { executionId: "another-execution" }],
    ["context", { contextId: "another-context" }],
    ["runtime", { kind: "embedded" }],
    ["runtime", { runtimeRef: "hmac-sha256:v1:private-runtime" }],
    ["context", { invoker: { state: "present" } }],
    ["exact", { decisionDisplays: [] }],
    ["enforcement", { coverageState: "enforced" }],
    ["action", { summary: "PRIVATE_REPLY_MARKER" }],
    ["exact", { decisions: [] }],
    ["exact", { nextDecisionCursor: "a:1:1" }],
    ["exact", null],
  ] as const)("rejects invalid %s %j from the public audit inspector", (target, patch) => {
    const fixture = codexAuditFixture();
    if (patch) {
      Object.assign(fixture.targets[target], patch);
    } else {
      fixture.selectors.pop();
    }
    expect(() =>
      inspectCodexAudit({
        selectors: fixture.selectors,
        expectedExecutions: 3,
        privateValues: ["PRIVATE_REPLY_MARKER"],
        query: (args: string[]) => fixture.replies.get(args.join(" ")),
      }),
    ).toThrow();
  });
});

describe("Codex audit package CLI boundary", () => {
  it("enables audit identity only in the opted-in package fixture and queries the public CLI", () => {
    const root = auditTempDirs.make("openclaw-codex-audit-");
    const { file, read, write, json } = fixtureFiles(root);
    const configPath = file("state/openclaw.json");
    const configure = (auditIdentity = "0") =>
      runAssertions(root, ["configure"], {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_CODEX_NPM_PLUGIN_AUDIT_IDENTITY: auditIdentity,
      });
    const readConfig = () => JSON.parse(read("state/openclaw.json"));
    const defaultConfig = configure();
    expect(defaultConfig.status, defaultConfig.stderr).toBe(0);
    expect(readConfig()).not.toHaveProperty("logging.audit.executionIdentity");
    const configured = configure("1");
    expect(configured.status, configured.stderr).toBe(0);
    expect(readConfig()).toMatchObject({
      logging: { audit: { enabled: true, executionIdentity: true } },
      gateway: { mode: "local", bind: "loopback", auth: { mode: "token" } },
    });
    const fixture = codexAuditFixture();
    const databasePath = path.join(root, "state", "state", "openclaw.sqlite");
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(
        "CREATE TABLE execution_identity_contexts (run_id TEXT, execution_id TEXT, context_id TEXT, created_at INTEGER)",
      );
      const insert = database.prepare(
        "INSERT INTO execution_identity_contexts VALUES (?, ?, ?, ?)",
      );
      fixture.selectors.forEach((selector, index) =>
        insert.run(selector.runId, selector.executionId, selector.contextId, index),
      );
    } finally {
      database.close();
    }
    json("replies.json", Object.fromEntries(fixture.replies));
    const cliPath = write(
      "openclaw-fixture.cjs",
      `const fs = require("node:fs");
const path = require("node:path");
const [command, ...args] = process.argv.slice(2);
if (command !== "audit" || args.pop() !== "--json") process.exit(2);
const replies = JSON.parse(fs.readFileSync(path.join(__dirname, "replies.json"), "utf8"));
const reply = replies[args.join(" ")];
if (!reply) process.exit(3);
process.stdout.write(JSON.stringify(reply));\n`,
    );
    const result = runAssertions(root, ["assert-audit", "PRIVATE_REPLY_MARKER"], {
      OPENCLAW_E2E_CLI_BIN: cliPath,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('codex_audit_identity: {"executionCount":3}');
  });
});
