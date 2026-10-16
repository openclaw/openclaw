import { fork } from "node:child_process";
import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import * as vocabulary from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { withinTest } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as state from "../state/openclaw-state-db.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { sqliteMaintenanceEntrypoints } from "./sqlite-maintenance-runtime.test-support.js";
import * as ledger from "./update-run-ledger.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { renderUpdateRunReport } from "./update-run-report.js";
import { parseUpdateAdmissionVerdict } from "./update-run-schema.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import * as windowsUser from "./windows-user-sid.js";

type ResultStep = Parameters<typeof updateRunStepsFromResultStep>[0];
const tempDirs = createTempDirTracker();
const channel = "discord";
const accountId = "primary";
const admissionRouting = {
  requester: { channel, accountId, senderId: "sender", authorizationSource: "owner-allowlist" },
  sessionKey: "agent:main:discord:channel:fixture-channel",
  deliveryContext: {
    channel,
    to: "channel:fixture-channel",
    accountId,
    threadId: "fixture-thread",
  },
  campaignId: "fixture-update-campaign",
};

function isolatedOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-update-ledger-") } };
}

function createLedger(
  options: ReturnType<typeof isolatedOptions> = isolatedOptions(),
  input: Parameters<typeof ledger.createUpdateRun>[0] = { trigger: "cli" },
) {
  const run = ledger.createUpdateRun(input, options);
  return {
    ...run,
    read: () => expectDefined(ledger.getUpdateRun(run.runId, options), "persisted update run"),
    originJson: () => {
      const row = state
        .openOpenClawStateDatabase(options)
        .db.prepare("SELECT origin_json FROM update_runs WHERE run_id = ?")
        .get(run.runId) as { origin_json: string };
      return row.origin_json;
    },
    result: (result: ResultStep) => {
      for (const step of updateRunStepsFromResultStep(result)) {
        ledger.recordUpdateRunStep(run.runId, step, options);
      }
    },
    phase: (
      phase: Parameters<typeof ledger.recordUpdateRunPhase>[1],
      patch: Parameters<typeof ledger.recordUpdateRunPhase>[2] = {},
    ) => ledger.recordUpdateRunPhase(run.runId, phase, patch, options),
    step: (step: Parameters<typeof ledger.recordUpdateRunStep>[1]) =>
      ledger.recordUpdateRunStep(run.runId, step, options),
    repair: (attempt: Parameters<typeof ledger.recordUpdateRunRepairAttempt>[1]) =>
      ledger.recordUpdateRunRepairAttempt(run.runId, attempt, options),
    verify: (verification: Parameters<typeof ledger.recordUpdateRunVerification>[1]) =>
      ledger.recordUpdateRunVerification(run.runId, verification, options),
    finish: (result: Parameters<typeof ledger.finishUpdateRun>[1]) =>
      ledger.finishUpdateRun(run.runId, result, options),
  };
}

function expectText(text: string, included: string[], excluded: string[] = []) {
  for (const value of included) {
    expect(text).toContain(value);
  }
  for (const value of excluded) {
    expect(text).not.toContain(value);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await state.closeOpenClawStateDatabaseAsync();
  state.closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

it("persists and reports installed admission through the existing origin metadata", () => {
  const options = isolatedOptions();
  const run = createLedger(options);
  const admission = {
    owner: "installed" as const,
    fallbackReason: "update-admission-unsupported-target",
  };
  const saved = run.phase("staging", { origin: { admission } });
  expect(saved.admission).toEqual(admission);
  const retained = run.read()!;
  expect(retained.admission).toEqual(admission);
  expect(retained.origin.candidateAdmission).toBeUndefined();
  expect(ledger.listUpdateRuns({}, options)[0]?.admission).toEqual(admission);
  const report = renderUpdateRunReport(retained).markdown;
  expect(report).toContain("Update safety checks ran in the installed updater");
  expect(report).toContain("update-admission-unsupported-target");
  expect(JSON.parse(run.originJson()).admission).toEqual(admission);
});

it.each([false, true])("prioritizes origin receipts (full recovery budget=%s)", (fullRecovery) => {
  const options = isolatedOptions();
  const message = "diagnostic ".repeat(100);
  const candidateVersion = `2026.9.5+${"v".repeat(70)}`;
  const installedVersion = `2026.9.4+${"v".repeat(70)}`;
  const checks = Array.from({ length: 4 }, (_, index) => ({
    name: `check-${index}-${"x".repeat(115)}`,
    status: "refuse" as const,
    detail: message,
  }));
  const verdict = expectDefined(
    parseUpdateAdmissionVerdict({
      protocol: 1,
      verdict: "refuse",
      reasons: checks.map(() => ({ code: "invalid-config", message, nextAction: message })),
      warnings: Array.from({ length: 32 }, (_, index) => ({
        code: `warning-${index}`,
        message,
      })),
      facts: { candidateVersion, installedVersion, checks },
    }),
    "admission verdict",
  );
  const drivers = Array.from({ length: vocabulary.UPDATE_RUN_DRIVER_LIMIT }, (_, index) => ({
    host: "\0".repeat(255),
    pid: Number.MAX_SAFE_INTEGER - index,
    startIdentity: "9".repeat(128),
  }));
  const capture = {
    manifestSha256: "a".repeat(64),
    configWrites: [],
    warnings: [
      {
        kind: "undeclared-migration-resources" as const,
        pluginId: "legacy",
        message: "warning",
      },
    ],
    status: "restore-failed" as const,
  };
  const receipts = {
    driver: drivers[0],
    previousDrivers: drivers.slice(1),
    ...(fullRecovery ? { updateRecoveryCapture: capture } : {}),
    windowsUserSid: "S-1-5-21-100",
  };
  vi.spyOn(windowsUser, "readWindowsUserSid").mockReturnValue(receipts.windowsUserSid);
  if (fullRecovery) {
    capture.warnings[0]!.message += "w".repeat(
      16 * 1024 - Buffer.byteLength(JSON.stringify(receipts)),
    );
  }
  const run = createLedger(options, {
    trigger: "cli",
    origin: {
      ...receipts,
      ...admissionRouting,
      doctorHint: message,
      nextAction: message,
      admission: { owner: "candidate", protocol: 1, candidateVersion, checks },
      candidateAdmission: verdict,
    },
  });
  const retained = run.read();
  const { origin, admission } = retained;
  const originJson = run.originJson();
  expect(Buffer.byteLength(originJson)).toBeLessThanOrEqual(16 * 1024);
  if (fullRecovery) {
    expect(Buffer.byteLength(originJson)).toBe(16 * 1024);
    expect(originJson).toBe(JSON.stringify(receipts));
    expect(origin).toStrictEqual(receipts);
    expect(admission).toBeUndefined();
    expect(ledger.listUpdateRuns({}, options)[0]?.admission).toBeUndefined();
  } else {
    expect(origin.driver).toEqual(drivers[0]);
    expect(origin.previousDrivers).toEqual(drivers.slice(1));
    expect(origin).toMatchObject(admissionRouting);
    expect(admission?.candidateVersion).toBe(candidateVersion);
    expect(admission?.checks?.map((check) => check.name)).toEqual(
      checks.map((check) => check.name),
    );
    expect(origin.candidateAdmission?.reasons.map((reason) => reason.code)).toEqual(
      verdict.reasons.map((reason) => reason.code),
    );
    expect(origin.candidateAdmission?.facts).toMatchObject({
      candidateVersion,
      installedVersion,
    });
    expect(renderUpdateRunReport(retained).markdown).toContain(
      "Update safety checks ran in the candidate updater",
    );
  }
});

it.each([
  ["selected", "state-volume"],
  ["refused", "snapshot-capacity-insufficient"],
  ["unavailable", "snapshot-location-unavailable"],
] as const)("retains snapshot capacity evidence (%s)", (outcome, reason) => {
  const options = isolatedOptions();
  const run = createLedger(options);
  const directory = `${options.env.OPENCLAW_STATE_DIR}.update-captures`;
  const snapshotCapacity = {
    reason,
    sqliteBytes: 1_048_576,
    pluginBytes: 2_097_152,
    requiredBytes: 8_388_608,
    candidates: [
      {
        kind: "explicit-tmpdir" as const,
        directory: "/synthetic/tmp",
        availableBytes: outcome === "refused" ? 1024 : 16_777_216,
        ...(outcome !== "refused" ? { allocationError: "not a directory" } : {}),
      },
      {
        kind: "state-volume" as const,
        directory,
        availableBytes: outcome === "refused" ? 2048 : 16_777_216,
        ...(outcome === "unavailable" ? { allocationError: "permission denied" } : {}),
      },
    ],
    selection: outcome === "selected" ? { kind: "state-volume" as const, directory } : null,
  };
  const step = {
    name: "candidate snapshot",
    exitCode: outcome === "selected" ? 0 : 1,
    snapshotCapacity,
  };
  run.result(step);
  run.finish({ status: outcome === "selected" ? "succeeded" : "failed" });
  const retained = run.read();
  const redactedDirectory = "$OPENCLAW_STATE_DIR.update-captures";
  const expected = structuredClone(snapshotCapacity);
  expected.candidates[1]!.directory = redactedDirectory;
  if (expected.selection) {
    expected.selection.directory = redactedDirectory;
  }
  expect(retained.steps.find((entry) => entry.step === step.name)?.snapshotCapacity).toEqual(
    expected,
  );
  const report = renderUpdateRunReport(retained).markdown;
  expectText(
    report,
    [redactedDirectory, "8 MiB", "1 MiB SQLite", "2 MiB plugin files"],
    [options.env.OPENCLAW_STATE_DIR],
  );
  if (outcome !== "selected") {
    expect(report).toContain("TMPDIR");
  }
  expect(snapshotCapacity.candidates[1]?.directory).toBe(directory);
});

it("bounds Doctor evidence before ledger validation without changing full messages", () => {
  const run = createLedger();
  const changes: NonNullable<ResultStep["configChanges"]> = [
    { kind: "key", key: "k".repeat(2048) },
    ...Array.from({ length: 40 }, (_, index) => ({
      kind: "migration" as const,
      message: `${index}: ${"🤖".repeat(2000)}`,
    })),
  ];
  const original = structuredClone(changes);
  const steps = updateRunStepsFromResultStep({
    name: "openclaw doctor",
    exitCode: 1,
    configChanges: changes,
    configWriteRefusal: {
      reason: "r".repeat(2048),
      message: "m".repeat(2048),
      keys: Array.from({ length: 40 }, (_, index) => `${index}:${"k".repeat(2048)}`),
    },
  });
  const boundedChanges = steps.flatMap((step) => (step.configChange ? [step.configChange] : []));
  const refusal = expectDefined(steps[0]?.configWriteRefusal, "Doctor refusal");
  expect(boundedChanges).toHaveLength(32);
  expect(refusal.keys).toHaveLength(32);
  const texts = [
    ...steps.map((step) => step.detail ?? ""),
    ...boundedChanges.map((change) => (change.kind === "key" ? change.key : change.message)),
    refusal.message,
    refusal.reason,
    ...refusal.keys,
  ];
  expect(Math.max(...texts.map((text) => text.length))).toBeLessThanOrEqual(1024);
  expect(() => steps.forEach(run.step)).not.toThrow();
  expect(changes).toEqual(original);
});
it.each(["committed", "refused"] as const)(
  "retains terminal Doctor config evidence (%s)",
  (outcome) => {
    const run = createLedger();
    const keys = ["meta", "plugins", "wizard"];
    const migration = "Enabled the configured provider plugin.";
    const step: ResultStep = {
      name: "openclaw doctor",
      exitCode: outcome === "committed" ? 0 : 1,
      ...(outcome === "committed"
        ? {
            configChanges: [
              ...keys.map((key) => ({ kind: "key" as const, key })),
              { kind: "migration" as const, message: migration },
            ],
          }
        : {
            configWriteRefusal: {
              keys,
              reason: "config-input-changed",
              message: "An operator saved the config before publication.",
            },
          }),
    };
    run.result(step);
    run.finish({
      status: outcome === "committed" ? "succeeded" : "failed",
      ...(outcome === "refused" ? { reason: "repair-requires-config-change" } : {}),
    });
    const retained = run.read();
    const report = renderUpdateRunReport(retained).markdown;
    expect(report).toContain(keys.join(", "));
    if (outcome === "committed") {
      expect(
        retained.steps.flatMap((entry) => (entry.configChange ? [entry.configChange] : [])),
      ).toEqual(step.configChanges);
      expect(report).toContain(migration);
      expect(report).not.toContain("repair-requires-config-change");
    } else {
      expect(retained.steps.find((entry) => entry.step === step.name)?.configWriteRefusal).toEqual(
        step.configWriteRefusal,
      );
      expectText(report, [
        "config-input-changed",
        "An operator saved the config before publication.",
        "Doctor could not promote config changes.",
      ]);
    }
  },
);
it.each(["running", "terminal"] as const)(
  "isolates synchronous phase capture for %s rows",
  (rowState) => {
    const options = isolatedOptions();
    const created = ledger.createUpdateRun({ trigger: "cli", target: { kind: "git" } }, options);
    const before =
      rowState === "terminal"
        ? ledger.finishUpdateRun(created.runId, { status: "failed", reason: "fixture" }, options)
        : created;
    let captured: UpdateRunRecord | undefined;
    const result = ledger.recordUpdateRunPhase(
      created.runId,
      "staging",
      { target: { sha: "abcdef1234567890" } },
      options,
      (record) => {
        expect(record).toEqual(before);
        captured = record;
        record.target.kind = "package";
        record.phase = "finished";
      },
    );
    expect(captured).toBeDefined();
    if (rowState === "terminal") {
      expect(result).toEqual(before);
    } else {
      expect(result).toMatchObject({
        phase: "staging",
        target: { kind: "git", sha: "abcdef1234567890" },
      });
    }
    expect(ledger.getUpdateRun(created.runId, options)).toEqual(result);
  },
);

it("keeps phase order and merges repeated steps while preserving terminal outcomes and later boot facts", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const run = createLedger(undefined, {
    trigger: "chat",
    origin: { sessionKey: "agent:main:update" },
    before: { version: "2026.9.1" },
  });
  clock.mockReturnValue(2_000);
  run.phase("staging", { target: { kind: "git", sha: "abcdef" } });
  run.step({ step: "fetch", status: "in_progress", startedAtMs: 2_100 });
  for (const exitCode of [1, 0]) {
    run.result({
      name: "fetch",
      exitCode,
      ...(exitCode
        ? { failureFacts: [{ check: "fetch", code: "EACCES", message: "Permission denied" }] }
        : {}),
    });
  }
  clock.mockReturnValue(3_000);
  run.phase("validating", {
    step: { step: "fetch", status: "completed", endedAtMs: 2_900 },
  });
  run.phase("requested", { origin: { campaignId: "campaign-1" } });
  const current = run.read();
  expect(current).toMatchObject({
    phase: "validating",
    target: { kind: "git", sha: "abcdef" },
    origin: { sessionKey: "agent:main:update", campaignId: "campaign-1" },
  });
  expect(current?.steps).toEqual([
    { step: "requested", status: "completed", startedAtMs: 1_000, endedAtMs: 2_000 },
    { step: "staging", status: "completed", startedAtMs: 2_000, endedAtMs: 3_000 },
    { step: "fetch", status: "completed", exitCode: 0, startedAtMs: 2_100, endedAtMs: 2_900 },
    { step: "validating", status: "in_progress", startedAtMs: 3_000 },
  ]);
  clock.mockReturnValue(4_000);
  const terminal = run.finish({
    status: "failed",
    reason: "doctor-failed",
    after: { version: "2026.9.3" },
    downtimeMs: 400,
  });
  expect(terminal).toMatchObject({
    phase: "finished",
    status: "failed",
    finishedAtMs: 4_000,
    downtimeMs: 400,
  });
  expect(run.finish({ status: "succeeded" })).toEqual(terminal);
  expect(run.phase("staging", {})).toEqual(terminal);
  expect(run.step({ step: "late", status: "completed" })).toEqual(terminal);
  expect(run.repair({ attempt: 1, status: "succeeded", startedAtMs: 4_000 })).toEqual(terminal);
  expect(run.verify({ serviceRunning: true }).confirmedAtMs).toBeNull();
  clock.mockReturnValue(5_000);
  const booted = run.verify({ booted: true, versionMatch: true });
  expect(booted.confirmedAtMs).toBeNull();
  const verified = run.verify({
    readyz: true,
    settled: true,
    channelsReady: true,
    pluginErrors: [],
  });
  expect(verified).toMatchObject({
    status: "failed",
    reason: "doctor-failed",
    finishedAtMs: 4_000,
    confirmedAtMs: 5_000,
    verification: { booted: true, serviceRunning: true, versionMatch: true },
  });
  clock.mockReturnValue(6_000);
  expect(run.verify({ noticeDelivered: true }).confirmedAtMs).toBe(5_000);
});

it.each([
  ["failed", "failed"],
  ["succeeded", "completed"],
  ["skipped", "skipped"],
] as const)("finishes %s runs without changing recorded outcomes", (status, stepStatus) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const run = createLedger();
  run.phase("validating", {});
  const recordedSteps = [
    { step: "install", status: "completed", endedAtMs: 1_000 },
    { step: "validation attempt", status: "failed", endedAtMs: 1_000, detail: "Build failed." },
    { step: "optional check", status: "skipped", endedAtMs: 1_000 },
  ] as const;
  for (const step of recordedSteps) {
    run.step(step);
  }
  run.step({ step: "openclaw doctor", status: "in_progress", startedAtMs: 1_000 });
  clock.mockReturnValue(2_000);
  const nextAction = "Run openclaw update repair.";
  run.finish({ status, nextAction });
  state.closeOpenClawStateDatabaseForTest();

  const persisted = run.read();
  const completion = { status: stepStatus, endedAtMs: 2_000 };
  expect(persisted).toMatchObject({ phase: "finished", origin: { nextAction } });
  expect(persisted.steps).toEqual([
    { step: "requested", status: "completed", startedAtMs: 1_000, endedAtMs: 1_000 },
    expect.objectContaining({ step: "validating", ...completion }),
    ...recordedSteps,
    { step: "openclaw doctor", startedAtMs: 1_000, ...completion },
  ]);
  expect(run.finish({ status, nextAction: "later" })).toEqual(persisted);
});

it("records post-activation repair without reopening activation or retaining completed repair timestamps", () => {
  const run = createLedger();
  const clock = vi.spyOn(Date, "now").mockReturnValue(run.createdAtMs + 100);
  run.phase("validating", {});
  run.phase("repairing", {});
  run.phase("activating", {});
  run.phase("verifying", {});
  clock.mockReturnValue(run.createdAtMs + 200);
  const repairing = run.phase("repairing", {});
  expect(repairing.phase).toBe("repairing");
  expect(repairing.steps.find((step) => step.step === "repairing")).toEqual({
    step: "repairing",
    status: "in_progress",
    startedAtMs: run.createdAtMs + 200,
  });
  for (const phase of ["activating", "restarting", "validating"] as const) {
    expect(run.phase(phase, {}).phase).toBe("repairing");
  }
  expect(run.phase("verifying", {}).phase).toBe("verifying");
});

it.each(["bytes", "count"] as const)("rejects oversized retained step %s atomically", (bound) => {
  const options = isolatedOptions();
  let saved = ledger.createUpdateRun({ trigger: "cli" }, options);
  expect(() => {
    for (let index = 0; index < 130; index++) {
      saved = expectDefined(
        ledger.recordUpdateRunStep(
          saved.runId,
          {
            step: `finalize:${index}${bound === "bytes" ? "界".repeat(330) : ""}`,
            status: "completed",
          },
          options,
        ),
        "required finalization receipt",
      );
    }
  }).toThrow(/retained step.*limit/);
  expect(ledger.getUpdateRun(saved.runId, options)).toEqual(saved);
});

it("bounds every JSON column deterministically without splitting Unicode or losing the phase timeline", () => {
  const options = isolatedOptions();
  const large = "🦞".repeat(512);
  const origin = {
    requester: { channel: large, senderId: large },
    sessionKey: large,
    deliveryContext: { channel: large, to: large, accountId: large, threadId: large },
    campaignId: large,
    doctorHint: large,
    nextAction: large,
  };
  const run = createLedger(options, { trigger: "cli", origin });
  const repeated = ledger.createUpdateRun(
    { trigger: "cli", origin: { ...origin, requester: { senderId: large, channel: large } } },
    options,
  );
  expect(run.origin).toEqual(repeated.origin);
  run.phase("staging", {});
  for (let index = 0; index < 140; index += 1) {
    run.step({ step: `build-${index}`, status: "failed", detail: large });
  }
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    run.repair({ attempt, status: "failed", startedAtMs: attempt, summary: large });
  }
  run.repair({ attempt: 20, status: "succeeded", startedAtMs: 20 });
  run.verify({ pluginErrors: Array.from({ length: 40 }, (_, index) => `${index}: ${large}`) });
  const persisted = run.read();
  expect(persisted?.steps.slice(0, 2).map((step) => step.step)).toEqual(["requested", "staging"]);
  expect(persisted?.steps.at(-1)?.step).toBe("build-139");
  expect(persisted?.repair.filter((attempt) => attempt.attempt === 20)).toEqual([
    { attempt: 20, status: "succeeded", startedAtMs: 20 },
  ]);
  expect(persisted?.verification.pluginErrors?.at(-1)).toContain("39:");
  const { db } = state.openOpenClawStateDatabase(options);
  const row = db.prepare("SELECT * FROM update_runs WHERE run_id = ?").get(run.runId);
  const columns = Object.entries(row ?? {}).filter(([key]) => key.endsWith("_json"));
  expect(columns).toHaveLength(7);
  for (const [column, value] of columns) {
    expect(typeof value, column).toBe("string");
    if (typeof value !== "string") {
      throw new Error(`Expected JSON in ${column}`);
    }
    expect(Buffer.byteLength(value), column).toBeLessThanOrEqual(16 * 1024);
    expect(() => JSON.parse(value), column).not.toThrow();
    expect(value, column).not.toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/u);
  }
  run.step({ step: "unicode", status: "completed", detail: `${"x".repeat(1_023)}🦞tail` });
  expect(run.read()?.steps.at(-1)?.detail).toBe("x".repeat(1_023));
});

it("preserves every phase and its timestamps when multibyte details exceed the JSON budget", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const run = createLedger();
  const phases = vocabulary.UPDATE_RUN_PHASES.filter((phase) => phase !== "finished");
  for (const [index, phase] of phases.entries()) {
    clock.mockReturnValue(1_000 + index * 100);
    run.phase(phase, {
      step: { step: phase, status: "in_progress", detail: "界".repeat(1_024) },
    });
  }
  clock.mockReturnValue(2_000);
  run.finish({ status: "failed", reason: "restart-unhealthy" });
  const persisted = run.read()!;
  expect(persisted.steps.map(({ step }) => step)).toEqual(phases);
  expect(persisted.steps.map(({ startedAtMs }) => startedAtMs)).toEqual(
    phases.map((_, index) => 1_000 + index * 100),
  );
  expect(persisted.steps.map(({ endedAtMs }) => endedAtMs)).toEqual(
    phases.map((_, index) => (index === phases.length - 1 ? 2_000 : 1_100 + index * 100)),
  );
  expect(persisted.steps.at(-1)?.status).toBe("failed");
  expect(Buffer.byteLength(JSON.stringify(persisted.steps))).toBeLessThanOrEqual(16 * 1024);
});

it("redacts private diagnostics while preserving model refs, URLs, and recovery selectors", () => {
  const options = {
    env: { ...isolatedOptions().env, HOME: "/Users/example", USERPROFILE: "C:\\Users\\example" },
    redactPaths: ["/opt/openclaw-candidate", "\\\\host\\share"],
  };
  const run = createLedger(options, {
    trigger: "cli",
    origin: {
      nextAction: "Run openclaw update cleanup --dry-run for state /Users/example/.openclaw.",
    },
  });
  const detail =
    "doctor failed in /Users/example/private/config.json and C:\\Users\\example\\private.json with token=synthetic-test-token";
  const step = {
    step: "doctor",
    status: "failed" as const,
    detail,
    stdout: "RAW_LOG_MUST_NOT_PERSIST",
  };
  run.step(step);
  const summary = `openai/gpt-5.6-luna: use /update; see https://docs.openclaw.ai/cli/update, http://host/share/x and https://host/share/x. Read config:${options.env.OPENCLAW_STATE_DIR}/state/openclaw.sqlite and file:///Users/example/module.js and /opt/openclaw-candidate/config.json and \\\\host\\share\\x; token=synthetic-test-token`;
  run.repair({ attempt: 1, status: "failed", startedAtMs: 1, summary });
  const persisted = run.read()!;
  expect(persisted.steps.at(-1)?.detail).toContain("~/private/config.json");
  expect(persisted.origin.nextAction).toContain("~/.openclaw");
  expectText(
    expectDefined(persisted.repair[0]?.summary, "repair summary"),
    [
      "openai/gpt-5.6-luna: use /update",
      "https://docs.openclaw.ai/cli/update",
      "http://host/share/x",
      "https://host/share/x",
    ],
    ["\\\\host\\share"],
  );
  expectText(
    JSON.stringify(persisted),
    ["doctor failed"],
    [
      "/Users/example",
      "Users\\\\example",
      options.env.OPENCLAW_STATE_DIR,
      "/opt/openclaw-candidate",
      "synthetic-test-token",
      "RAW_LOG_MUST_NOT_PERSIST",
    ],
  );
});

it("merges independent CLI and gateway process writes into the same WAL run", async ({
  signal,
}) => {
  const options = isolatedOptions();
  const run = createLedger(options);
  const database = state.openOpenClawStateDatabase(options);
  expect(database.db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  const writerUrl = resolveRuntimeWorkerUrl(sqliteMaintenanceEntrypoints.updateLedger);
  const children = ["cli", "gateway"].map((role) => {
    const child = fork(writerUrl, [run.runId, role], {
      execArgv: resolveRuntimeWorkerArgv(writerUrl).slice(0, -1),
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const exited = once(child, "exit").then(([code]) => {
      if (code !== 0) {
        throw new Error(`${role} exited ${code}`);
      }
    });
    const waitFor = (expected: string) =>
      Promise.race([
        once(child, "message").then(([message]) => {
          if (message !== expected) {
            throw new Error(`Unexpected ${role} ${expected} message`);
          }
        }),
        exited.then(() => {
          throw new Error(`${role} exited before ${expected}`);
        }),
      ]);
    const ready = waitFor("ready");
    const written = ready.then(() => waitFor("written"));
    return { child, ready, written, exited };
  });
  try {
    const allWritten = Promise.all(children.map(({ written }) => written));
    await withinTest(
      Promise.race([Promise.all(children.map(({ ready }) => ready)), allWritten]),
      signal,
    );
    for (const { child } of children) {
      child.send("start");
    }
    await withinTest(allWritten, signal);
    // Writes stay concurrent; handle retirement must not race another lifecycle writer.
    for (const { child, exited } of children) {
      child.send("close");
      await withinTest(exited, signal);
    }
    const persisted = run.read();
    const expected = ["cli", "gateway"].flatMap((role) =>
      Array.from({ length: 16 }, (_, index) => `${role}-${index}`),
    );
    expect(
      persisted?.steps
        .filter((step) => expected.includes(step.step))
        .map((step) => step.step)
        .toSorted(),
    ).toEqual(expected.toSorted());
    expect(persisted).toMatchObject({
      phase: "verifying",
      after: { version: "2026.9.3" },
      verification: {
        booted: true,
        serviceRunning: true,
        versionMatch: true,
        channelsReady: true,
        settled: true,
        readyz: true,
        pluginErrors: [],
      },
    } satisfies Partial<UpdateRunRecord>);
    expect(persisted?.confirmedAtMs).toEqual(expect.any(Number));
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null) {
        child.kill();
      }
    }
    await Promise.allSettled(children.flatMap(({ written, exited }) => [written, exited]));
  }
}, 30_000);
