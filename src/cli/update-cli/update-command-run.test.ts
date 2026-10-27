import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withTriageTerminal } from "../../commands/triage.test-support.js";
import { cronOwnerHardeningEntrypoints } from "../../cron/owner-hardening-runtime.test-support.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { GatewayStateOwnerContentionError } from "../../infra/gateway-state-owner.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { triageTestRuntimeEntrypoints } from "../../infra/triage-runtime.test-support.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import type { UpdateDoctorLintFinding } from "../../infra/update-doctor-lint-schema.js";
import { createUpdateErrorFact } from "../../infra/update-failure-facts.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import * as updateRunLedger from "../../infra/update-run-ledger.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import {
  loadUpdateRecovery,
  UpdateRecoveryRequiredError,
} from "../../infra/update-run-recovery.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import * as stepWrites from "../../infra/update-run-write.async.js";
import { runStep } from "../../infra/update-runner-command.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import * as updateFailureTriage from "../../infra/update-triage.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createUpdateProgress } from "./progress.js";
import { confirmUpdateDowngrade } from "./shared.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { snapshotUpdateFixtureTree } from "./update-command-filesystem-snapshot.test-support.js";
import { resultFixture, stepFixture } from "./update-command-fixtures.test-support.js";
import { failUpdateCommandRun } from "./update-command-result.js";
import {
  admitUpdateCommandRun,
  completeUpdateCommandRun,
  createUpdateRunProgress,
  withUpdatePreviewSignals,
} from "./update-command-run.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";
import { publishUpdateCommandTerminalResultForTest as publishUpdateCommandTerminalResult } from "./update-command-terminal.test-support.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: async () => false,
}));

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

const sourceImportArgs = resolveRuntimeWorkerUrl(
  updateExecutorNativeEntrypoints.commandRun,
).pathname.endsWith(".ts")
  ? ["--import", path.resolve("scripts/tsx.mjs")]
  : [];

const dirs = useAutoCleanupTempDirTracker(afterEach);

function createRun(prefix: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const env = { OPENCLAW_STATE_DIR: dirs.make(prefix), ...extraEnv };
  return { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
}

const updateResult = (overrides: Parameters<typeof resultFixture>[1]) =>
  resultFixture(undefined, { status: "error", durationMs: 1, ...overrides });

afterEach(async () => {
  vi.mocked(crypto.randomUUID).mockReset();
  await closeStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("persists fingerprint warnings before closing a rolled-back run", async () => {
  const run = createRun("rollback-fingerprint-warning-");
  const { env } = run;
  const warnings = [
    "baseline package fingerprint incomplete after 30 s; rollback will be verified by the retained package copy",
    "Package fingerprint verification unavailable; rollback verified by the retained package copy's directory identity and version.",
  ];
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const result = await publishUpdateCommandTerminalResult(
    { opts: { json: true, run }, ownedManagedUpdateEnv: env },
    updateResult({
      reason: "doctor-failed",
      before: { version: "1.0.0" },
      after: { version: "1.0.0" },
      recovery: {
        serviceRestartSafe: true,
        packageRollbackVerified: true,
        service: "healthy",
        version: "1.0.0",
      },
      durationMs: 50,
      steps: [
        stepFixture("global install rollback", {
          command: "restore",
          cwd: env.OPENCLAW_STATE_DIR,
          durationMs: 1,
          exitCode: 0,
          advisory: { kind: "recoverable-maintenance", message: warnings.join("\n") },
          warnings,
        }),
      ],
    }),
    { rolledBack: true, downtimeMs: 25 },
  );
  expect(result).toMatchObject({ status: "error", reason: "doctor-failed" });
  const recorded = getUpdateRun(run.runId, { env })!;
  expect(recorded).toMatchObject({
    status: "rolled-back",
    reason: "doctor-failed",
    downtimeMs: 25,
  });
  expect(recorded.steps).toEqual(
    expect.arrayContaining(
      warnings.map((detail) => expect.objectContaining({ status: "completed", detail })),
    ),
  );
  for (const warning of warnings) {
    expect(renderUpdateRunReport(recorded).markdown).toContain(warning);
  }
});

it("keeps restored-generation completion with its helper across CLI unwind", () => {
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
  const run = createRun("update-rollback-owner-");
  const { env } = run;
  const result = updateResult({
    reason: "restart-unhealthy",
    before: { version: "2026.9.1" },
    after: { version: "2026.9.1" },
    recovery: {
      serviceRestartSafe: true,
      packageRollbackVerified: true,
      version: "2026.9.1",
    },
  });
  completeUpdateCommandRun(result, run);
  completeUpdateCommandRun(result, run);
  expect(getUpdateRun(run.runId, { env })).toMatchObject({
    status: "running",
    after: { version: "2026.9.1" },
  });
  finishUpdateRun(run.runId, { status: "rolled-back", reason: result.reason }, { env });
  completeUpdateCommandRun(result, run);
  expect(getUpdateRun(run.runId, { env })?.status).toBe("rolled-back");
});

it.each([false, true])(
  "new update settles a dead driver only outside preview (dryRun=%s)",
  async (dryRun) => {
    const root = dirs.make("update-admission-driver-loss-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
    const driver = readUpdateRunDriver();
    if (!driver) {
      throw new Error("Test process identity is unavailable");
    }
    const previous = createUpdateRun({
      trigger: "cli",
      origin: { driver: { ...driver, startIdentity: String(Number(driver.startIdentity) + 1) } },
    });
    const recorded = recordUpdateRunPhase(previous.runId, "activating");

    const next = await admitUpdateCommandRun({ opts: { dryRun }, root });

    expect(getUpdateRun(previous.runId)).toEqual(
      dryRun
        ? recorded
        : expect.objectContaining({
            status: "failed",
            phase: "finished",
            reason: "abandoned",
            finishedAtMs: expect.any(Number),
          }),
    );
    expect(getUpdateRun(next.runId)).toMatchObject({ status: "running" });
  },
);

function pendingRecovery() {
  const root = dirs.make("update-admission-recovery-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
  const env = { ...process.env };
  const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
  const from = { root, nodePath: process.execPath, version: "1.0.0", buildId: null };
  // This fixture owns every writer of its disposable state directory.
  const record = createRetainedUpdateRecovery(
    { runId: run.runId, from, to: { ...from, version: "2.0.0" } },
    { env },
  );
  closeOpenClawStateDatabaseForTest();
  const snapshot = () => snapshotUpdateFixtureTree(root);
  return { root, run, record, snapshot };
}

it("refuses interrupted update admission without touching SQLite when reusing its run ID", async () => {
  const { root, run, record, snapshot } = pendingRecovery();
  vi.stubEnv(UPDATE_RUN_ID_ENV, run.runId);
  const before = snapshot();
  await expect(admitUpdateCommandRun({ opts: { dryRun: false }, root })).rejects.toBeInstanceOf(
    UpdateRecoveryRequiredError,
  );
  expect(snapshot()).toEqual(before);
  expect(loadUpdateRecovery(run.runId, { env: run.env })).toEqual(record);
});

it.each(["displaced", "replacement", "both", "unreadable"] as const)(
  "blocks admission when publication has no canonical DB (%s)",
  async (familyState) => {
    const { root, run, snapshot } = pendingRecovery();
    vi.stubEnv(UPDATE_RUN_ID_ENV, run.runId);
    const file = path.join(root, "state", "openclaw.sqlite");
    const family = path.join(path.dirname(file), `.openclaw-restore-${randomUUID()}-0`);
    fs.mkdirSync(family);
    fs.renameSync(file, path.join(family, "displaced"));
    if (familyState === "replacement") {
      fs.renameSync(path.join(family, "displaced"), path.join(family, "replacement"));
    } else if (familyState === "both") {
      fs.copyFileSync(path.join(family, "displaced"), path.join(family, "replacement"));
    } else if (familyState === "unreadable") {
      fs.writeFileSync(path.join(family, "displaced"), "incomplete database");
    }
    const before = snapshot();
    await expect(admitUpdateCommandRun({ opts: {}, root })).rejects.toThrow(
      "Interrupted shared-database publication is read-only while full-state recovery is deferred",
    );
    expect(fs.existsSync(file)).toBe(false);
    expect(snapshot()).toEqual(before);
  },
);

it("does not complete an operationally pending update from diagnostic success", () => {
  const { run, record, snapshot } = pendingRecovery();
  const before = snapshot();
  const result = updateResult({ status: "ok" });
  const completed = completeUpdateCommandRun(result, run);
  expect(completed).toMatchObject({ status: "error", reason: "update-recovery-pending" });
  failUpdateCommandRun(new Error("outer unwind"), run);
  expect(snapshot()).toEqual(before);
  expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("running");
  expect(loadUpdateRecovery(run.runId, { env: run.env })).toEqual(record);
});

it("saves the complete error diagnostics before printing the Markdown path", async () => {
  const secret = "sk-synthetic-terminal-" + "x".repeat(48);
  const run = createRun("update-terminal-report-", { OPENAI_API_KEY: secret });
  const { env } = run;
  const reportPath = path.join(env.OPENCLAW_STATE_DIR, "update-reports", `${run.runId}.md`);
  let savedAtPublication: { markdown: string; failure: string; inventory: string } | undefined;
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation((value) => {
    if (String(value) === `Report: ${reportPath}`) {
      const markdown = fs.readFileSync(reportPath, "utf8");
      const diagnosticLink = /^Bounded diagnostic JSON: ([^\r\n]+)$/mu.exec(markdown)?.[1];
      if (!diagnosticLink) {
        throw new Error("Published failure report is missing its diagnostic JSON link.");
      }
      const failure = fs.readFileSync(
        path.resolve(path.dirname(reportPath), diagnosticLink),
        "utf8",
      );
      expect(Buffer.byteLength(failure)).toBeLessThanOrEqual(8 * 1024);
      const inventoryPath = JSON.parse(failure)
        .error.split("Complete Doctor lint inventory: ")[1]
        .split(" Doctor lint receipt: ")[0]
        .replace("$OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
      const inventory = fs.readFileSync(inventoryPath, "utf8");
      savedAtPublication = { markdown, failure, inventory };
    }
  });
  const doctorLintFindings: UpdateDoctorLintFinding[] = Array.from({ length: 40 }, (_, index) => ({
    checkId: `fixture/check-${index}`,
    severity: index === 0 ? "error" : "warning",
    message: `Finding ${index}: ${secret}`,
  }));
  // A valid UUID with a numeric tail must remain a readable diagnostic link.
  vi.mocked(crypto.randomUUID).mockReturnValue("00000000-0000-4000-8000-123456789012");
  await publishUpdateCommandTerminalResult(
    { opts: { run } },
    updateResult({
      reason: "doctor-failed",
      steps: [
        stepFixture("candidate doctor lint", {
          command: "doctor --lint --json",
          cwd: "/fixture",
          durationMs: 1,
          doctorLintFindings,
        }),
      ],
    }),
    { rolledBack: false },
  );
  expect(log.mock.calls.flat().join("\n")).toContain(`Report: ${reportPath}`);
  expect(savedAtPublication).toBeDefined();
  for (const finding of doctorLintFindings) {
    expect(savedAtPublication?.markdown).toContain(finding.checkId);
    expect(savedAtPublication?.inventory).toContain(finding.checkId);
  }
  expect(JSON.stringify(savedAtPublication)).not.toContain(secret);
  expect(savedAtPublication?.markdown).toContain("doctor-failed");
});

// Real signals terminate a separate process; the parent never emits into Vitest.
it.skipIf(process.platform === "win32").each([
  { signal: "SIGTERM", mode: "fresh" },
  { signal: "SIGTERM", mode: "no-run" },
  { signal: "SIGTERM", mode: "resolved" },
  { signal: "SIGINT", mode: "resolved-foreign-before" },
  { signal: "SIGINT", mode: "resolved-foreign-after" },
  { signal: "SIGINT", mode: "repeat" },
  { signal: "SIGINT", mode: "inherited" },
  { signal: "SIGINT", mode: "handoff" },
  { signal: "SIGINT", mode: "pending" },
  { signal: "SIGINT", mode: "changed" },
  { signal: "SIGINT", mode: "completed" },
  { signal: "SIGINT", mode: "missing" },
] as const)(
  "disposes only the owned unchanged preview before $signal exit ($mode)",
  async ({ signal, mode }) => {
    const root = dirs.make("update-preview-signal-");
    const caller = path.join(root, "preview.mjs");
    fs.writeFileSync(
      caller,
      `
      import fs from 'node:fs';
      import { withCliProcessScope, withCliCommandCleanup } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.cliCleanupScope).href)};
      import { runCliWithExitFinalization } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.oneShotExit).href)};
      import { registerSignalExitGate } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.signalExitBarrier).href)};
      import { createUpdateRun, finishUpdateRun, getUpdateRun, recordUpdateRunPhase } from ${JSON.stringify(resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.updateRunLedger).href)};
      import { createRetainedUpdateRecovery } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.retainedRecovery).href)};
      import { closeOpenClawStateDatabaseForTest } from ${JSON.stringify(resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.stateDatabase).href)};
      import { admitUpdateCommandRun, withUpdatePreviewSignals } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.commandRun).href)};
      import { resolveUpdateCommandTarget } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.commandTarget).href)};
      import { resolveCommandProcessSignal } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.processSpawn).href)};
      const opts = { dryRun: true };
      const mode = ${JSON.stringify(mode)};
      if (mode === 'inherited') process.env.OPENCLAW_UPDATE_RUN_ID = createUpdateRun({trigger:'cli'}).runId;
      const run = mode === 'no-run' ? undefined : await admitUpdateCommandRun({ opts, root: ${JSON.stringify(root)}, installKind: "package" });
      const preview = () => withUpdatePreviewSignals({ ...opts, run }, async () => {
        const commandSignal = resolveCommandProcessSignal();
        const sibling = run ? createUpdateRun({ trigger: 'cli' }) : undefined;
        if (mode.startsWith('resolved')) {
          const foreign = () => recordUpdateRunPhase(run.runId, 'requested', { target: { tag: 'foreign' } });
          if (mode === 'resolved-foreign-before') foreign();
          const root = ${JSON.stringify(root)};
          await resolveUpdateCommandTarget({ ...opts, run }, { triageTarget: { root, env: run.env } }, undefined, {
            startedAt: Date.now(), postCoreUpdateResume: false, postCoreUpdateChannel: undefined,
            timeoutMs: 1000, shouldRestart: false, requestedChannel: null, devTarget: undefined,
            controlPlaneUpdateSentinelMeta: null, discoveredRoot: root, installKind: 'git',
            servicePlan: undefined,
          }, { enter: () => { throw new Error('preview must not acquire a mutable executor'); } }, 1000);
          if (mode === 'resolved-foreign-after') foreign();
        }
        if (mode === 'repeat') {
          registerSignalExitGate(new Promise((resolve) => process.once('message', resolve)));
          process.once('SIGINT', () => process.send('interrupted'));
        }
        if (mode === 'handoff') process.env.OPENCLAW_UPDATE_RUN_HANDOFF = '1';
        if (mode === 'pending' || mode === 'missing') {
          const from = { root: ${JSON.stringify(root)}, nodePath: process.execPath, version: '1.0.0', buildId: null };
          createRetainedUpdateRecovery({ runId: run.runId, from, to: { ...from, version: '2.0.0' } }, { env: run.env });
        }
        if (mode === 'changed') recordUpdateRunPhase(run.runId, 'staging');
        if (mode === 'completed') finishUpdateRun(run.runId, { status: 'skipped', reason: 'dry-run' });
        const expected = run ? getUpdateRun(run.runId) : undefined;
        if (mode === 'missing') {
          closeOpenClawStateDatabaseForTest();
          const base = ${JSON.stringify(path.join(root, "state"))};
          const family = base + '/.openclaw-restore-00000000-0000-4000-8000-000000000001-0';
          fs.mkdirSync(family);
          fs.renameSync(base + '/openclaw.sqlite', family + '/displaced');
        }
        process.send({ runId: run?.runId, expected, sibling });
        process.channel.ref();
        await new Promise(resolve => {
          process.once(${JSON.stringify(signal)}, resolve);
        });
        fs.writeFileSync(${JSON.stringify(path.join(root, "command-signal.json"))}, JSON.stringify({ present: commandSignal !== undefined, aborted: commandSignal?.aborted === true }));
      });
      if (mode === "inherited") await preview();
      else {
        let resources;
        await withCliProcessScope(() => runCliWithExitFinalization({
          run: () => withCliCommandCleanup(false, async cleanup => {
            resources = cleanup.pluginResources;
            await preview();
            // A later command result must not overwrite the accepted signal.
            process.exitCode = 19;
          }),
          onError: error => { throw error; },
          finalize: async () => { await resources?.release(); },
        }));
      }
      fs.writeFileSync(${JSON.stringify(path.join(root, "signal-owner-unwound"))}, "settled");
      closeOpenClawStateDatabaseForTest();
      process.disconnect();
    `,
    );
    const child = spawn(process.execPath, [...sourceImportArgs, caller], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_UPDATE_RUN_ID: undefined,
        OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
        OPENCLAW_UPDATE_POST_CORE: undefined,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const closed = once(child, "close");
    let releaseGate: ReturnType<typeof setTimeout> | undefined;
    try {
      const message = await Promise.race([
        once(child, "message").then(
          ([payload]) =>
            payload as {
              runId?: string;
              expected: ReturnType<typeof getUpdateRun>;
              sibling?: ReturnType<typeof createUpdateRun>;
            },
        ),
        closed.then(() => {
          throw new Error(`Preview exited before ready: ${stderr}`);
        }),
      ]);
      const firstSignal = mode === "repeat" ? once(child, "message") : undefined;
      expect(child.kill(signal)).toBe(true);
      if (firstSignal) {
        await firstSignal;
        expect(child.kill(signal)).toBe(true);
        // Hold cleanup across actual repeat-signal delivery; no metadata timeout is involved.
        releaseGate = setTimeout(() => {
          if (child.connected) {
            child.send("release");
          }
        }, 100);
      }
      const [code, exitSignal] = await closed;
      expect(JSON.parse(fs.readFileSync(path.join(root, "command-signal.json"), "utf8"))).toEqual({
        present: true,
        aborted: true,
      });
      expect(code ?? (exitSignal === "SIGINT" ? 130 : 143)).toBe(signal === "SIGINT" ? 130 : 143);
      if (mode !== "inherited") {
        expect(exitSignal).toBeNull();
        expect(fs.readFileSync(path.join(root, "signal-owner-unwound"), "utf8")).toBe("settled");
      }
      if (mode === "no-run") {
        expect(fs.existsSync(path.join(root, "state"))).toBe(false);
        return;
      }
      if (!message.runId || !message.sibling) {
        throw new Error("Admitted preview omitted its original run or sibling");
      }
      const options =
        mode === "missing"
          ? {
              path: path.join(
                root,
                "state",
                ".openclaw-restore-00000000-0000-4000-8000-000000000001-0",
                "displaced",
              ),
            }
          : { env: { OPENCLAW_STATE_DIR: root } };
      const record = getUpdateRun(message.runId, options);
      if (mode.startsWith("resolved")) {
        expect(message.expected).toMatchObject({
          target: { kind: "git", installationMethod: "git-checkout" },
          steps: expect.arrayContaining([
            expect.objectContaining({ step: "installation-inspection", status: "completed" }),
          ]),
        });
      }
      if (mode === "fresh" || mode === "repeat" || mode === "resolved") {
        expect(record).toMatchObject({
          status: "skipped",
          phase: "finished",
          reason: "interrupted",
          finishedAtMs: expect.any(Number),
        });
        expect(record?.steps.some((step) => step.status === "in_progress")).toBe(false);
      } else {
        expect(record).toEqual(message.expected);
      }
      expect(getUpdateRun(message.sibling.runId, options)).toEqual(message.sibling);
      if (mode === "missing") {
        for (const suffix of ["", "-wal", "-shm"]) {
          expect(fs.existsSync(path.join(root, "state", `openclaw.sqlite${suffix}`))).toBe(false);
        }
      }
    } finally {
      clearTimeout(releaseGate);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    }
  },
  60_000,
);

it("removes preview signal ownership on exceptional unwind", async () => {
  const root = dirs.make("update-preview-cleanup-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
  const run = await admitUpdateCommandRun({ opts: { dryRun: true }, root });
  const before = [process.listeners("SIGINT"), process.listeners("SIGTERM")];
  const operation = withUpdatePreviewSignals({ dryRun: true, run }, async () => {
    throw new Error("preview error");
  });
  await expect(operation).rejects.toThrow("preview error");
  expect([process.listeners("SIGINT"), process.listeners("SIGTERM")]).toEqual(before);
});

it.each([false, true])(
  "preserves reported downgrade decisions through cleanup and triage (json=%s)",
  async (json) => {
    const run = createRun("update-reported-exit-");
    const { env } = run;
    const opts = { json, yes: true, run };
    const triage = vi.fn(async () => ({ status: "cancelled" as const }));
    vi.spyOn(updateFailureTriage, "prepareUpdateFailureTriage").mockResolvedValue(triage);
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const cleaned: string[] = [];
    let reported: unknown;
    let recorded: ReturnType<typeof getUpdateRun> | undefined;
    await withTriageTerminal(true, async () => {
      const outcome = withUpdateFailureTriage(opts, { env }, () =>
        withUpdateCommandTerminalResult(async (registerRun) => {
          registerRun(run);
          await withUpdateCommandRecoveryUnwind(
            opts,
            {
              triageTarget: { env },
              windowsTaskAutoStartRecovery: {
                suspended: Promise.resolve(true),
                beginMutation() {},
                assertRecoveryCurrent() {},
                handoff() {},
                interrupted: () => false,
                restore: async () => {
                  cleaned.push("restore");
                },
                complete: async () => {
                  cleaned.push("complete");
                },
              },
            },
            async () => {
              try {
                await confirmUpdateDowngrade({
                  opts,
                  currentVersion: "2.0.0",
                  targetVersion: "1.0.0",
                  tag: "latest",
                });
              } catch (error) {
                reported = error;
                recorded = getUpdateRun(run.runId, { env });
                throw error;
              }
            },
          );
        }, opts),
      );
      await expect(outcome).rejects.toEqual(new ExitError(json ? 1 : 0));
      await expect(outcome).rejects.toBe(reported);
      expect(cleaned).toEqual(["restore", "complete"]);
      expect(getUpdateRun(run.runId, { env })).toEqual(recorded);
      expect(recorded).toMatchObject({
        status: "skipped",
        reason: json ? "downgrade-confirmation-required" : "cancelled",
      });
      expect(triage).not.toHaveBeenCalled();
      expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    });
  },
);

async function withProgressRun(
  exercise: (
    run: Parameters<typeof createUpdateRunProgress>[0],
    guards: ReturnType<typeof createUpdateCommandExecutionGuards>,
    root: string,
  ) => Promise<void>,
) {
  const root = dirs.make("update-progress-receipt-");
  const env = { OPENCLAW_STATE_DIR: path.join(root, "profile") };
  const control = path.join(root, "control");
  fs.mkdirSync(control);
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
  const guards = createUpdateCommandExecutionGuards({ run }, root);
  try {
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      guards.admitExecutor(await executor.enter(root));
      await exercise(run, guards, root);
    });
  } finally {
    await closeStateDatabaseForTest();
  }
}

function observeHostLedgerWrites() {
  const calls = (["prepare", "exec"] as const).map((method) =>
    vi.spyOn(DatabaseSync.prototype, method),
  );
  return {
    get writes() {
      return calls
        .flatMap((call) => call.mock.calls.map(([sql]) => sql))
        .filter((sql) =>
          /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+["`]?update_runs\b/i.test(sql),
        );
    },
    restore: () => calls.forEach((call) => call.mockRestore()),
  };
}

it("awaits committed steps before commands and display", async () => {
  await withProgressRun((run, guards, root) =>
    withTriageTerminal(false, async () => {
      const { env } = run;
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      const presentation = createUpdateProgress(true, run);
      try {
        const progress = createUpdateRunProgress(run, presentation.progress, guards.recordStep);
        updateRunLedger.recordUpdateRunPhase(run.runId, "validating", {}, { env });
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const writeStep = stepWrites.recordUpdateRunStepAsync;
        const writer = vi
          .spyOn(stepWrites, "recordUpdateRunStepAsync")
          .mockImplementation(async (...args) => {
            const committed = await writeStep(...args);
            if (args[1].step === "fetch" && args[1].status === "in_progress") {
              entered.resolve();
              await release.promise;
            }
            return committed;
          });
        const host = observeHostLedgerWrites();
        const reread = vi.spyOn(updateRunLedger, "getUpdateRun").mockImplementation(() => {
          throw new Error("step presentation must use its committed row");
        });
        const runCommand = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
        const pending = runStep({
          name: "fetch",
          argv: ["run", "fetch"],
          cwd: root,
          stepIndex: 0,
          totalSteps: 3,
          progress,
          runCommand,
        });
        try {
          await awaitGateBeforeSettlement(
            entered.promise,
            pending,
            "Command finished without its worker receipt",
          );
          expect(runCommand).not.toHaveBeenCalled();
          expect(log).not.toHaveBeenCalledWith("validating — fetch...");
          expect(
            (await updateRunLedger.getUpdateRunAsync(run.runId, { env }))?.steps,
          ).toContainEqual(expect.objectContaining({ step: "fetch", status: "in_progress" }));
          release.resolve();
          await expect(pending).resolves.toMatchObject({ name: "fetch", exitCode: 0 });
          expect(runCommand).toHaveBeenCalledOnce();
          for (const [index, result] of [
            { name: "build", stdoutTail: "Build type error" },
            {
              name: "doctor",
              advisory: {
                kind: "package-post-install-doctor" as const,
                message: "Skipped optional cache cleanup",
              },
              warnings: ["Skipped optional cache cleanup", "Skipped legacy cache cleanup"],
            },
          ].entries()) {
            const { name } = result;
            const step = { name, command: `run ${name}`, index: index + 1, total: 3 };
            await progress.onStepStart?.(step);
            await progress.onStepComplete?.({ ...step, ...result, durationMs: 1, exitCode: 1 });
          }
          expect(log.mock.calls).toEqual(
            expect.arrayContaining([["validating — fetch..."], ["validating — build..."]]),
          );
          const output = log.mock.calls.flat();
          expect(output.join("\n")).toContain("Build type error");
          expect(output.join("\n")).toContain("Skipped optional cache cleanup");
          expect(
            output.filter((line) => typeof line === "string" && line.startsWith("Phase:")),
          ).toEqual(["Phase: requested", "Phase: validating"]);
          expect(host.writes).toEqual([]);
        } finally {
          release.resolve();
          await pending.catch(() => undefined);
          writer.mockRestore();
          host.restore();
          reread.mockRestore();
        }
        const recorded = getUpdateRun(run.runId, { env });
        expect(
          recorded?.steps
            .filter((step) => step.step === "fetch" || step.step === "build")
            .map(({ step, status, detail }) => ({ step, status, detail })),
        ).toEqual([
          { step: "fetch", status: "completed", detail: undefined },
          { step: "build", status: "failed", detail: "Exit code: 1; Build type error" },
        ]);
        expect(recorded?.steps).toEqual(
          expect.arrayContaining(
            [
              { step: "doctor" },
              { step: "warning:doctor", detail: "Skipped optional cache cleanup" },
              { step: "warning:doctor:2", detail: "Skipped legacy cache cleanup" },
            ].map((step) => expect.objectContaining({ ...step, status: "completed" })),
          ),
        );
      } finally {
        presentation.dispose();
      }
    }),
  );
});

it.each([
  "in_progress",
  "completed",
  "command-cleanup",
  "nonzero-with-results",
  "nonzero-without-results",
] as const)(
  "identifies a progress ledger failure without losing the command outcome (%s)",
  async (outcome) => {
    await withProgressRun(async (run, guards, root) => {
      const nonzero = outcome === "nonzero-with-results" || outcome === "nonzero-without-results";
      const status = outcome === "command-cleanup" || nonzero ? "failed" : outcome;
      const commandStderr = "fixture candidate checkout refused";
      const cause = new GatewayStateOwnerContentionError("/synthetic/openclaw.sqlite");
      const commandFailure = new CommandProcessCleanupError({
        cause: new Error("command tree still alive"),
      });
      const writeStep = stepWrites.recordUpdateRunStepAsync;
      let receiptAttempted = false;
      const writer = vi
        .spyOn(stepWrites, "recordUpdateRunStepAsync")
        .mockImplementation(async (...args) => {
          const committed = await writeStep(...args);
          if (args[1].step === "preflight worktree" && args[1].status === status) {
            receiptAttempted = true;
            throw cause;
          }
          return committed;
        });
      const display = { onStepStart: vi.fn(), onStepComplete: vi.fn() };
      const progress = createUpdateRunProgress(run, display, guards.recordStep);
      const results: UpdateStepResult[] = [];
      const runCommand = vi.fn(async () => {
        if (outcome === "command-cleanup") {
          throw commandFailure;
        }
        return {
          code: nonzero ? 17 : 0,
          stdout: "command completed",
          stderr: nonzero ? commandStderr : "",
        };
      });
      const host = observeHostLedgerWrites();
      try {
        const observed = await runStep({
          name: "preflight worktree",
          argv: ["git", "worktree", "add"],
          cwd: root,
          stepIndex: 1,
          totalSteps: 3,
          progress,
          runCommand,
          ...(outcome === "nonzero-without-results" ? {} : { results }),
        }).then(
          () => undefined,
          (error: unknown) => error,
        );
        const errors = collectNestedErrorCandidates(observed);
        expect(errors).toContain(cause);
        expect(errors).toContainEqual(
          expect.objectContaining({
            message: `Could not record update step "preflight worktree" (${status}): ${cause.message}`,
            cause,
          }),
        );
        expect(receiptAttempted).toBe(true);
        expect(hasCommandProcessCleanupError(observed)).toBe(outcome === "command-cleanup");
        expect(host.writes).toEqual([]);
        if (outcome === "command-cleanup") {
          expect(errors).toContain(commandFailure);
        }
        if (nonzero) {
          expect(errors).toContainEqual(
            expect.objectContaining({
              exitCode: 17,
              stderrTail: commandStderr,
              failureFacts: [
                expect.objectContaining({
                  check: "preflight worktree",
                  code: "command-failed",
                  message: commandStderr,
                }),
              ],
            }),
          );
          const { message } = createUpdateErrorFact("update", observed, run.env);
          expect(message).toContain("Exit code: 17");
          expect(message).toContain(commandStderr);
        }
        const calls = outcome === "in_progress" ? 0 : 1;
        expect(runCommand).toHaveBeenCalledTimes(calls);
        expect(display.onStepStart).toHaveBeenCalledTimes(calls);
        expect(results).toEqual(
          outcome === "in_progress" || outcome === "nonzero-without-results"
            ? []
            : [
                expect.objectContaining({
                  name: "preflight worktree",
                  exitCode: nonzero ? 17 : outcome === "command-cleanup" ? 1 : 0,
                }),
              ],
        );
        expect(display.onStepComplete).not.toHaveBeenCalled();
      } finally {
        writer.mockRestore();
        host.restore();
      }
    });
  },
);
