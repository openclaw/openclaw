import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertIdentityProjection,
  readIdentityRows,
} from "../../scripts/e2e/lib/npm-onboard-channel-agent/execution-identity.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const helper = path.resolve("scripts/e2e/lib/npm-onboard-channel-agent/execution-identity.mjs");
const domainRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;
const privateMarker = "PRIVATE_PACKAGE_AUDIT_FIXTURE";

function projection() {
  return {
    run: { runId: "admitted-run-1", executionId: "execution-1" },
    identity: {
      state: "present",
      context: {
        schemaVersion: 1,
        contextId: "context-1",
        executionId: "execution-1",
        runId: "admitted-run-1",
        trustDomain: { domainRef },
        invoker: { state: "absent" },
        ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
        agentPrincipal: { domainRef, principalRef: "main" },
        agentDefinition: { definitionRef: "main" },
        runtimeInstance: { runtimeRef: domainRef },
        applicableGrants: [],
        assurance: [],
        coverageState: "unattributed",
      },
    },
    decisionDisplays: [
      {
        provenance: { state: "verified", producer: "run-admission" },
        decision: { outcome: "not-applicable", reasonCode: "run_admission_identity_not_evaluated" },
        enforcement: { coverageState: "unattributed" },
      },
    ],
  };
}

describe("installed-package execution identity proof", () => {
  it("does not initialize missing audit state during inspection", () => {
    const state = tempDirs.make("openclaw-package-audit-empty-");
    expect(readIdentityRows(state)).toEqual([]);
    expect(readdirSync(state)).toEqual([]);
    expect(existsSync(path.join(state, "state/openclaw.sqlite"))).toBe(false);
  });

  it.each<[string, (result: ReturnType<typeof projection>) => void]>([
    ["missing identity", (result) => Object.assign(result.identity, { state: "unknown" })],
    ["wrong run", (result) => Object.assign(result.run, { runId: "other-run" })],
    [
      "fabricated invoker",
      ({ identity: { context } }) => Object.assign(context.invoker, { state: "present" }),
    ],
    [
      "raw runtime",
      ({ identity: { context } }) =>
        Object.assign(context.runtimeInstance, { runtimeRef: "raw-runtime" }),
    ],
    [
      "false enforcement",
      ({ decisionDisplays }) =>
        decisionDisplays.forEach(({ enforcement }) =>
          Object.assign(enforcement, { coverageState: "enforced" }),
        ),
    ],
    ["lost admission", (result) => Object.assign(result, { decisionDisplays: [] })],
  ])("rejects %s", (_label, mutate) => {
    const result = projection();
    mutate(result);
    expect(() =>
      assertIdentityProjection(result, JSON.stringify(result.identity.context), []),
    ).toThrow();
  });

  it.each(["export", "storage"])("rejects a private canary in %s", (where) => {
    const result = projection();
    const stored = JSON.stringify(result.identity.context);
    const exported = where === "export" ? { ...result, prompt: privateMarker } : result;
    expect(() =>
      assertIdentityProjection(exported, where === "storage" ? stored + privateMarker : stored, [
        privateMarker,
      ]),
    ).toThrow("execution identity exposed private fixture data");
  });

  it("rejects identity replacement and duplicate rows after the Gateway restart", () => {
    const home = tempDirs.make("openclaw-package-audit-restart-");
    const stateDir = path.join(home, ".openclaw");
    mkdirSync(path.join(stateDir, "state"), { recursive: true });
    const config = path.join(stateDir, "openclaw.json");
    writeFileSync(config, "{}");
    const beforePath = path.join(home, "before.json");
    const afterPath = path.join(home, "after.json");
    const before = projection();
    using db = new DatabaseSync(path.join(stateDir, "state/openclaw.sqlite"));
    const verify = () =>
      spawnSync(process.execPath, [helper, "verify", afterPath, beforePath], {
        encoding: "utf8",
        env: {
          HOME: home,
          OPENCLAW_HOME: home,
          OPENCLAW_TEST_STATE_HOME: home,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: config,
        },
      });
    db.exec("CREATE TABLE execution_identity_contexts (context_json TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO execution_identity_contexts VALUES (?)");
    insert.run(JSON.stringify(before.identity.context));
    writeFileSync(beforePath, JSON.stringify(before));
    writeFileSync(afterPath, JSON.stringify(before));
    expect(verify()).toMatchObject({ status: 0, stdout: "execution-1" });
    const after = projection();
    after.identity.context.runtimeInstance.runtimeRef = domainRef.replace(/b/gu, "c");
    db.prepare("UPDATE execution_identity_contexts SET context_json = ?").run(
      JSON.stringify(after.identity.context),
    );
    writeFileSync(afterPath, JSON.stringify(after));
    expect(verify().stderr).toContain("CLI context differs from persisted bytes");
    insert.run(JSON.stringify(after.identity.context));
    expect(verify().stderr).toContain("expected exactly one admitted execution identity");
  });
});
