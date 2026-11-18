import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import {
  assertIdentityProjection,
  readIdentityRows,
} from "../../scripts/e2e/lib/npm-onboard-channel-agent/execution-identity.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const helper = path.resolve("scripts/e2e/lib/npm-onboard-channel-agent/execution-identity.mjs");
const domainRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;
const privateMarker = "PRIVATE_PACKAGE_AUDIT_FIXTURE";
const json = JSON.stringify;
const admissionDecision = {
  provenance: { state: "verified", producer: "run-admission" },
  decision: { outcome: "not-applicable", reasonCode: "run_admission_identity_not_evaluated" },
};

function projection({
  state = "present",
  runId = "admitted-run-1",
  invoker = "absent",
  runtimeRef = domainRef,
  enforcement = "unattributed",
  admission = true,
} = {}) {
  return {
    run: { runId, executionId: "execution-1" },
    identity: {
      state,
      context: {
        schemaVersion: 1,
        contextId: "context-1",
        executionId: "execution-1",
        runId: "admitted-run-1",
        trustDomain: { domainRef },
        invoker: { state: invoker },
        ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
        agentPrincipal: { domainRef, principalRef: "main" },
        agentDefinition: { definitionRef: "main" },
        runtimeInstance: { runtimeRef },
        applicableGrants: [],
        assurance: [],
        coverageState: "unattributed",
      },
    },
    decisionDisplays: admission
      ? [{ ...admissionDecision, enforcement: { coverageState: enforcement } }]
      : [],
  };
}

it("does not initialize missing audit state during inspection", () => {
  const state = tempDirs.make("openclaw-package-audit-empty-");
  expect(readIdentityRows(state)).toEqual([]);
  expect(readdirSync(state)).toEqual([]);
});

it.each([
  ["missing identity", { state: "unknown" }],
  ["wrong run", { runId: "other-run" }],
  ["fabricated invoker", { invoker: "present" }],
  ["raw runtime", { runtimeRef: "raw-runtime" }],
  ["false enforcement", { enforcement: "enforced" }],
  ["lost admission", { admission: false }],
] as const)("rejects %s", (_label, overrides) => {
  const result = projection(overrides);
  expect(() => assertIdentityProjection(result, json(result.identity.context), [])).toThrow();
});

it.each(["export", "storage"])("rejects a private canary in %s", (where) => {
  const result = projection();
  const stored = json(result.identity.context);
  const exported = where === "export" ? { ...result, prompt: privateMarker } : result;
  const persisted = where === "storage" ? stored + privateMarker : stored;
  expect(() => assertIdentityProjection(exported, persisted, [privateMarker])).toThrow(
    "execution identity exposed private fixture data",
  );
});

it("rejects identity replacement and duplicate rows after the Gateway restart", () => {
  const home = tempDirs.make("openclaw-package-audit-restart-");
  const stateDir = path.join(home, ".openclaw");
  mkdirSync(path.join(stateDir, "state"), { recursive: true });
  writeFileSync(path.join(stateDir, "openclaw.json"), "{}");
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
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
    });
  db.exec("CREATE TABLE execution_identity_contexts (context_json TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO execution_identity_contexts VALUES (?)");
  insert.run(json(before.identity.context));
  writeFileSync(beforePath, json(before));
  writeFileSync(afterPath, json(before));
  expect(verify()).toMatchObject({ status: 0, stdout: "execution-1" });
  const after = projection({ runtimeRef: domainRef.replace(/b/gu, "c") });
  const context = json(after.identity.context);
  db.prepare("UPDATE execution_identity_contexts SET context_json = ?").run(context);
  writeFileSync(afterPath, json(after));
  expect(verify().stderr).toContain("CLI context differs from persisted bytes");
  insert.run(context);
  expect(verify().stderr).toContain("expected exactly one admitted execution identity");
});
