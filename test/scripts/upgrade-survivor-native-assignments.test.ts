import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import {
  assertImportedAssignments,
  assertPublishedAssignments,
} from "../../scripts/e2e/lib/upgrade-survivor/native-assignments.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const owner = {
  parentThreadId: "native-upgrade-parent",
  sessionId: "synthetic-original-session",
  lifecycleRevision: "synthetic-original-lifecycle",
  connectionFingerprint: "1".repeat(64),
};
const dirs = useAutoCleanupTempDirTracker(afterEach);

function publish(snapshot: unknown) {
  const root = dirs.make("native-upgrade-publication-");
  const output = path.join(root, "public");
  fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify(snapshot));
  fs.writeFileSync(path.join(root, "native-assignment-server.log"), "native fixture diagnostic");
  publishDiagnostics(root, output, (value: string) => value, "passed");
  return JSON.parse(fs.readFileSync(path.join(output, "summary.json"), "utf8"));
}

const running = "codex-thread:native-upgrade-running";
const completed = "codex-thread:native-upgrade-complete";

function releasedState() {
  return {
    tasks: [running, completed].map((runId, index) => ({
      task_id: `released-${index}`,
      run_id: runId,
      owner_key: "agent:native-proof:upgrade-native-proof",
      scope_kind: "session",
      detail_json: JSON.stringify({ nativeHistory: owner }),
      status: index === 0 ? "running" : "succeeded",
      delivery_status: index === 0 ? "not_applicable" : "pending",
      terminal_summary: index === 0 ? null : "NATIVE_UPGRADE_PENDING_RESULT",
    })),
    binding: { key: "original-binding", value: { sessionId: owner.sessionId } },
  };
}

function importedState() {
  const before = releasedState();
  return {
    ...before,
    binding: {
      ...before.binding,
      value: {
        ...before.binding.value,
        nativeSubagentTaskImport: { version: 1, taskIds: ["released-0", "released-1"] },
        nativeSubagentAssignments: {
          assignments: [
            { runId: running, owner },
            {
              runId: completed,
              owner,
              recordedCompletion: { result: "NATIVE_UPGRADE_PENDING_RESULT" },
            },
          ],
        },
      },
    },
  };
}

describe("native upgrade witness", () => {
  it("accepts authentic 9.4 initial locators without inventing later turn metadata", () => {
    const before = releasedState();
    expect(() => assertPublishedAssignments(before)).not.toThrow();
    expect(() => assertImportedAssignments(before, importedState())).not.toThrow();
    before.tasks[0]!.detail_json = JSON.stringify({
      nativeHistory: owner,
      nativeTurnId: "invented",
    });
    expect(() => assertPublishedAssignments(before)).toThrow("must not fabricate");
  });

  it("rejects a no-op import, dropped result, changed owner, and mutated source", () => {
    const before = releasedState();
    expect(() => assertImportedAssignments(before, before)).toThrow("did not import");
    const dropped = importedState();
    dropped.binding.value.nativeSubagentAssignments.assignments.pop();
    expect(() => assertImportedAssignments(before, dropped)).toThrow("both native assignments");
    const reowned = importedState();
    reowned.binding.value.nativeSubagentAssignments.assignments[0]!.owner = {
      ...owner,
      sessionId: "successor",
    };
    expect(() => assertImportedAssignments(before, reowned)).toThrow();
    const changed = importedState();
    changed.tasks[1]!.terminal_summary = "changed";
    expect(() => assertImportedAssignments(before, changed)).toThrow(
      "changed released native source rows",
    );
  });

  it("requires package-bound proof before publishing a successful retirement cell", () => {
    const snapshot = {
      status: "passed",
      scenario: "legacy-operator-state",
      updateRestartMode: "manual",
      baseline: { spec: "openclaw@2026.9.4", version: "2026.9.4" },
      candidate: { kind: "tarball", version: "2026.9.6" },
      candidateInstallMode: "updater",
      updateOutcome: "success",
      phases: [],
      backupRollback: {
        status: "passed",
        baselineVersion: "2026.9.4",
        candidateVersion: "2026.9.6",
        runtime: {
          version: "2026.9.4",
          schemaVersions: { state: 16, agent: 19 },
          manifestSha256: "a".repeat(64),
          entrySha256: "a".repeat(64),
        },
        candidateSchemaVersions: { state: 17, agent: 21 },
        archive: { sha256: "a".repeat(64) },
        before: {
          databases: [
            {
              kind: "agent",
              agentId: "main",
              present: true,
              userVersion: 19,
              contentVersion: 19,
              sessions: [{ key: "synthetic", sessionId: "synthetic" }],
              tables: [{ table: "transcript_events", rows: 1, sha256: "a".repeat(64) }],
            },
          ],
          files: [],
        },
        preflights: [{ agentId: "main", status: "exact", foundVersion: 19, targetVersion: 19 }],
        sessionReads: [{ agentId: "main", count: 1 }],
      },
      installedVersion: "2026.9.6",
      nativeAssignmentEligibility: {
        status: "required",
        candidateVersion: "2026.9.6",
        candidateSha256: "a".repeat(64),
        companionSha256: "b".repeat(64),
        sourceSha: "c".repeat(40),
      },
      nativeAssignments: {
        status: "passed",
        baselineVersion: "2026.9.4",
        candidateVersion: "2026.9.6",
        candidateSha256: "a".repeat(64),
        source: "published-gateway-agent-native-events",
        backend: "synthetic-codex-websocket",
        baselineCore: "OpenClaw 2026.9.4 (3a9d69d)",
        sessionKey: "agent:native-proof:upgrade-native-proof",
        recoveredRunIds: [running, completed],
        baselineCodex: {
          name: "@openclaw/codex",
          version: "2026.9.4",
          integrity: "sha512-c3ludGhldGlj",
        },
        firstHopImported: true,
        retainedHistory: true,
        retainedCompletion: true,
        unconfirmedClosePreserved: true,
        confirmedCloseSettled: true,
        noReplay: true,
        incidentalPath: "/private/not-for-publication",
      },
    };
    const report = publish(snapshot);
    expect(report.logs["native-assignment-server.log"]).toBe("native fixture diagnostic");
    expect(report.nativeAssignments).toMatchObject({
      status: "passed",
      sourceSha: "c".repeat(40),
    });
    expect(JSON.stringify(report)).not.toContain("incidentalPath");
    expect(() => publish({ ...snapshot, nativeAssignmentEligibility: undefined })).toThrow(
      "Missing native assignment eligibility",
    );
    const skipped = publish({
      ...snapshot,
      nativeAssignmentEligibility: {
        status: "not-applicable",
        reason: "candidate retains the Task runtime SDK",
      },
      nativeAssignments: undefined,
    });
    expect(skipped.logs).not.toHaveProperty("native-assignment-server.log");
    expect(() => publish({ ...snapshot, nativeAssignments: undefined })).toThrow(
      "omitted native assignment proof",
    );
    expect(() =>
      publish({
        ...snapshot,
        nativeAssignments: { ...snapshot.nativeAssignments, candidateSha256: "d".repeat(64) },
      }),
    ).toThrow("Invalid native assignment preservation");
    expect(() =>
      publish({
        ...snapshot,
        nativeAssignments: { ...snapshot.nativeAssignments, unconfirmedClosePreserved: false },
      }),
    ).toThrow("Invalid native assignment preservation");
  });
});
