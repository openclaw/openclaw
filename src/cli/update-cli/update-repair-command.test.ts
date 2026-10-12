import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  buildStatusUpdateRows,
  formatUpdateRestartStatusValue,
} from "../../commands/status-update-restart.js";
import {
  packageActivationIdentity,
  resolvePackageActivationAnchor,
} from "../../infra/package-update-activation-journal.js";
import { readPackageActivationReceipt } from "../../infra/package-update-activation.js";
import * as sqliteWorkerStore from "../../infra/sqlite-worker-store.js";
import { inspectUpdateRunDriver, readUpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  acknowledgeAbandonedUpdateRun,
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { readUpdateRunStatus } from "../../infra/update-run-status.js";
import { ABANDONED_UPDATE_RUN_MS } from "../../infra/update-run-timeouts.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { registerUpdateCli } from "../update-cli.js";
import { updateRepairCommand } from "./update-repair-command.js";

const mocks = vi.hoisted(() => ({
  finalize: vi.fn(async (_opts: unknown, _recoveryRunIds?: readonly string[]) => {}),
  readConfig: vi.fn(async () => ({ valid: true, config: {} })),
  resolveChannel: vi.fn(async () => ({ tag: "latest", version: "2026.9.3" as string | null })),
  configWriteAllowed: vi.fn(),
  ownershipAllowed: vi.fn(async () => {}),
  resolveRoot: vi.fn(async () => ""),
  reachable: vi.fn(async () => ({
    reachable: true,
    gatewayVersion: "2026.9.3",
    gatewayBuildId: "installed-build" as string | null,
    activatedPluginErrors: [] as { id: string; error: string }[],
    channelProbeErrors: [] as { id: string; error: string }[],
  })),
  readiness: vi.fn(async () => ({ healthz: 200, readyz: 200 })),
  runtime: { log: vi.fn(), error: vi.fn(), writeJson: vi.fn(), exit: vi.fn() },
}));

vi.mock("../../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: mocks.configWriteAllowed,
  readConfigFileSnapshot: mocks.readConfig,
}));
vi.mock("../../state/openclaw-state-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-state-ownership.js")>()),
  assertOpenClawStateWriteAllowedAtPath: mocks.ownershipAllowed,
}));
vi.mock("../daemon-cli/restart-health-probe.js", () => ({
  resolveGatewayRestartProbeContext: async () => ({ config: {}, auth: undefined }),
  confirmGatewayReachable: mocks.reachable,
  waitForGatewayHttpReadiness: mocks.readiness,
}));
vi.mock("./update-command-finalize.js", () => ({ updateFinalizeCommand: mocks.finalize }));
vi.mock("../../infra/update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-check.js")>()),
  resolveNpmChannelTag: mocks.resolveChannel,
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveUpdateRoot: mocks.resolveRoot,
}));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

const tempDirs = createTempDirTracker();
const now = Date.now();

function seedRun(
  params: {
    phase?: UpdateRunRecord["phase"];
    driver?: "live" | "exited" | "reused";
    ageMs?: number;
  } = {},
) {
  vi.mocked(Date.now).mockReturnValue(now - (params.ageMs ?? 3_600_000));
  let driver = params.driver ? readUpdateRunDriver() : undefined;
  if (params.driver && !driver) {
    throw new Error("Test process identity is unavailable");
  }
  if (driver && params.driver === "exited") {
    const child = spawnSync(process.execPath, ["-e", ""], { timeout: 5_000 });
    expect(child.status).toBe(0);
    driver = { ...driver, pid: child.pid };
  } else if (driver && params.driver === "reused") {
    driver = { ...driver, startIdentity: String(Number(driver.startIdentity) + 1) };
  }
  const run = createUpdateRun({
    trigger: "control-ui",
    before: { version: "2026.9.2" },
    ...(driver ? { origin: { driver } } : {}),
  });
  if (params.phase) {
    recordUpdateRunPhase(run.runId, params.phase);
  }
  vi.mocked(Date.now).mockReturnValue(now);
  return getUpdateRun(run.runId)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-update-repair-"));
  const root = tempDirs.make("openclaw-update-repair-install-");
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.3" }));
  fs.writeFileSync(
    path.join(root, "dist", "build-info.json"),
    JSON.stringify({ buildId: "installed-build" }),
  );
  mocks.resolveRoot.mockResolvedValue(root);
  mocks.readConfig.mockResolvedValue({ valid: true, config: {} });
  mocks.resolveChannel.mockReset().mockResolvedValue({ tag: "latest", version: "2026.9.3" });
  mocks.reachable.mockResolvedValue({
    reachable: true,
    gatewayVersion: "2026.9.3",
    gatewayBuildId: "installed-build",
    activatedPluginErrors: [],
    channelProbeErrors: [],
  });
  mocks.readiness.mockResolvedValue({ healthz: 200, readyz: 200 });
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

describe("update repair ledger recovery", () => {
  it.each(["aborted", "publishing"])(
    "exits nonzero while a released %s package record remains pending",
    async (phase) => {
      const installKey = await mocks.resolveRoot();
      const anchor = resolvePackageActivationAnchor(installKey);
      fs.mkdirSync(anchor, { mode: 0o700 });
      const journal = path.join(anchor, "operation.sqlite");
      const operationId = randomUUID();
      const db = new DatabaseSync(journal);
      fs.chmodSync(journal, 0o600);
      try {
        // Released in-anchor receipts belong to their original helper. The
        // public command must report pending recovery before finalization.
        db.exec("CREATE TABLE package_activation (slot INTEGER, phase TEXT, descriptor_json TEXT)");
        db.prepare("INSERT INTO package_activation VALUES (1, ?, ?)").run(
          phase,
          JSON.stringify({
            version: 1,
            operationId,
            authority: { installKey },
            anchorIdentity: packageActivationIdentity(anchor, true),
            journalIdentity: packageActivationIdentity(journal, false),
            parentIdentity: packageActivationIdentity(path.dirname(anchor), "parent"),
          }),
        );
      } finally {
        db.close();
      }
      const before = fs.readFileSync(journal);

      await runRegisteredCli({
        register: registerUpdateCli,
        argv: ["update", "repair", "--yes", "--json"],
      });

      expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
      expect(mocks.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining(path.join(anchor, "recovery.mjs")),
      );
      expect(mocks.finalize).not.toHaveBeenCalled();
      expect(readPackageActivationReceipt(installKey)).toMatchObject({ phase, operationId });
      expect(fs.readFileSync(journal)).toEqual(before);
    },
  );

  it.each([
    { legacy: true, target: "2026.9.3" },
    { legacy: false, target: "2026.9.2" },
  ])(
    "acknowledges a package-owner refusal without maintenance ($legacy)",
    async ({ legacy, target }) => {
      const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
      const detail =
        "Update refused: package manager owner is unknown; no changes were made. Run this OpenClaw install through its active npm, pnpm, or Bun global shim, or reinstall it with that package manager, then retry.";
      const captureSteps: UpdateRunRecord["steps"] = [
        {
          step: "original-state-capture",
          status: "completed",
          detail: "Original state retained for manual recovery.",
        },
        {
          step: "warning:original-state-capture:1",
          status: "completed",
          detail: "Optional plugin files could not be captured.",
        },
      ];
      recordUpdateRunStep(run.runId, { step: "driver:adopted", status: "completed" });
      if (legacy) {
        recordUpdateRunStep(run.runId, { step: "requested", status: "failed", detail });
      } else {
        recordUpdateRunStep(run.runId, { step: "installation-inspection", status: "in_progress" });
        for (const step of captureSteps) {
          recordUpdateRunStep(run.runId, step);
        }
      }
      finishUpdateRun(run.runId, {
        status: legacy ? "failed" : "skipped",
        reason: legacy ? "update-failed" : "unmanaged-package-install",
      });
      mocks.resolveChannel.mockResolvedValue({ tag: "latest", version: target });

      await runRegisteredCli({
        register: registerUpdateCli,
        argv: ["update", "repair", "--yes", "--json"],
      });

      expect(mocks.finalize).not.toHaveBeenCalled();
      expect(mocks.reachable).not.toHaveBeenCalled();
      expect(mocks.readiness).not.toHaveBeenCalled();
      const runStatus = await readUpdateRunStatus();
      if (runStatus.runStatusError !== undefined) {
        throw new Error(runStatus.runStatusError);
      }
      const lastRun = runStatus.lastRun!;
      expect(lastRun).toMatchObject({
        runId: run.runId,
        status: "skipped",
        reason: "unmanaged-package-install",
      });
      expect(lastRun.steps).toContainEqual(
        expect.objectContaining({ step: "reconcile:acknowledged", status: "completed" }),
      );
      if (legacy) {
        expect(lastRun.steps).toContainEqual(
          expect.objectContaining({ step: "requested", detail }),
        );
      } else {
        expect(lastRun.steps).toEqual(
          expect.arrayContaining(captureSteps.map((step) => expect.objectContaining(step))),
        );
      }
      expect(renderUpdateRunReport(lastRun).headline).not.toContain("update failed");
      expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "ok",
          mode: "repair",
          restart: false,
          reconciledRuns: [run.runId],
        }),
      );
      await updateRepairCommand({});
      expect(mocks.finalize).toHaveBeenCalledExactlyOnceWith({}, [], undefined);
    },
  );

  it.each([
    "newer target",
    "unknown target",
    "mutated run",
    "unknown capture warning",
    "failed capture warning",
    "different failure",
    "new run during lookup",
  ])("does not acknowledge a refusal with %s", async (problem) => {
    const run = createUpdateRun({ trigger: "cli" });
    recordUpdateRunStep(run.runId, {
      step: "requested",
      status: "failed",
      detail:
        problem === "different failure"
          ? "Registry unavailable; no changes were made."
          : "Update refused: package manager owner is unknown; no changes were made.",
    });
    if (problem === "mutated run") {
      recordUpdateRunStep(run.runId, { step: "finalize:doctor", status: "failed" });
    }
    if (problem === "unknown capture warning") {
      recordUpdateRunStep(run.runId, {
        step: "warning:original-state-capture:restore",
        status: "completed",
      });
    } else if (problem === "failed capture warning") {
      recordUpdateRunStep(run.runId, {
        step: "warning:original-state-capture:1",
        status: "failed",
      });
    }
    finishUpdateRun(run.runId, { status: "failed", reason: "update-failed" });
    const before = getUpdateRun(run.runId);
    mocks.resolveChannel.mockImplementationOnce(async () => {
      if (problem === "new run during lookup") {
        vi.mocked(Date.now).mockReturnValue(now + 1);
        const newer = createUpdateRun({ trigger: "cli" });
        finishUpdateRun(newer.runId, { status: "failed", reason: "doctor-failed" });
      }
      return {
        tag: "latest",
        version:
          problem === "unknown target"
            ? null
            : problem === "newer target"
              ? "2026.9.4"
              : "2026.9.3",
      };
    });

    await updateRepairCommand({});

    expect(getUpdateRun(run.runId)).toEqual(before);
    expect(mocks.finalize).toHaveBeenCalledOnce();
  });

  it.each(["self", "parent"] as const)(
    "continues repair within its owning %s run",
    async (owner) => {
      const run = seedRun({ phase: "validating", driver: "live", ageMs: 60_000 });
      if (owner === "parent") {
        const driver = readUpdateRunDriver();
        const start = getFileLockProcessStartTime(process.ppid);
        if (!driver || start === null) {
          throw new Error("Controlling parent identity is unavailable");
        }
        recordUpdateRunPhase(run.runId, "validating", {
          origin: { driver: { ...driver, pid: process.ppid, startIdentity: String(start) } },
        });
      }
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);

      await updateRepairCommand({});

      expect(mocks.finalize).toHaveBeenCalledExactlyOnceWith({}, []);
      expect(getUpdateRun(run.runId)).toMatchObject({
        status: "running",
        phase: "validating",
        steps: expect.arrayContaining([
          expect.objectContaining({ step: "finalize:repair-continuation", status: "completed" }),
        ]),
      });
      expect(mocks.reachable).not.toHaveBeenCalled();
    },
  );

  it.each([
    "live",
    "unobserved",
    "unrelated inherited ID",
    "unrecorded adopter",
    "recent request",
    "live staging driver",
    "young live driver",
  ] as const)("preserves the %s and refuses maintenance", async (owner) => {
    const young = owner === "recent request" || owner === "young live driver";
    const unobserved = owner === "unobserved" || owner === "unrelated inherited ID";
    const run = seedRun({
      phase: young ? undefined : owner === "live staging driver" ? "staging" : "validating",
      driver: owner === "recent request" ? undefined : "live",
      ageMs: young ? 60_000 : undefined,
    });
    if (unobserved) {
      recordUpdateRunPhase(run.runId, "validating", {
        origin: { driver: { ...run.origin.driver!, host: "other-host.invalid" } },
      });
    }
    if (owner === "unrecorded adopter") {
      recordUpdateRunStep(run.runId, { step: "driver:identity-unavailable", status: "completed" });
    }
    if (owner === "unrelated inherited ID" || owner === "unrecorded adopter") {
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
    }
    const current = getUpdateRun(run.runId)!;
    const pending = updateRepairCommand({});
    await expect(pending).rejects.toThrow(
      `Update ${run.runId} remains recorded as running (${run.phase});`,
    );
    if (owner === "live" || owner === "unobserved") {
      for (const detail of [
        `PID ${run.origin.driver!.pid}`,
        current.origin.driver!.host,
        unobserved ? "liveness: not observed" : "liveness: alive",
        `started ${new Date(run.createdAtMs).toISOString()}`,
        "age 3600s",
        `last activity ${new Date(current.updatedAtMs).toISOString()}`,
        "stop it through its owning host",
        "openclaw update repair",
      ]) {
        await expect(pending).rejects.toThrow(detail);
      }
    }
    if (owner === "unrecorded adopter") {
      await expect(pending).rejects.toThrow("unrecorded adopter");
      expect(getUpdateRun(run.runId)?.steps).not.toContainEqual(
        expect.objectContaining({ step: "finalize:repair-continuation" }),
      );
    }
    expect(getUpdateRun(run.runId)).toEqual(current);
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it.each([undefined, "staging"] as const)(
    "repairs an abandoned %s row through the public command without maintenance",
    async (phase) => {
      const run = seedRun({ phase });
      vi.mocked(Date.now).mockReturnValue(run.updatedAtMs);
      recordUpdateRunStep(run.runId, {
        step: "preflight",
        status: "failed",
        failureFacts: [
          { check: "preflight", code: "preflight-failed", message: "Old preflight failure" },
        ],
      });
      vi.mocked(Date.now).mockReturnValue(now);

      await runRegisteredCli({ register: registerUpdateCli, argv: ["update", "repair", "--json"] });

      expect(getUpdateRun(run.runId)).toMatchObject({ status: "failed", reason: "abandoned" });
      expect(listUpdateRuns({ active: true })).toEqual([]);
      expect(mocks.finalize).not.toHaveBeenCalled();
      expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "ok",
          mode: "repair",
          restart: false,
          reconciledRuns: [run.runId],
        }),
      );
      expect(mocks.runtime.exit).not.toHaveBeenCalledWith(1);
      const repaired = getUpdateRun(run.runId)!;
      expect(await buildStatusUpdateRows(null)).toEqual([
        { Item: "Update run", Value: "ℹ️ OpenClaw abandoned update reconciled." },
      ]);
      expect(renderUpdateRunReport(repaired).markdown).not.toContain("openclaw triage");
      expect(
        formatUpdateRestartStatusValue(
          { kind: "update", status: "error", ts: now, stats: { runId: run.runId } },
          {
            warn: (message) => `warning: ${message}`,
            muted: (message) => `muted: ${message}`,
          },
        ),
      ).toBe("muted: ℹ️ OpenClaw abandoned update reconciled.");
      expect(getUpdateRun(run.runId)).toEqual(repaired);
      await updateRepairCommand({});
      expect(mocks.finalize).toHaveBeenCalledExactlyOnceWith({}, [], undefined);
      expect(getUpdateRun(run.runId)).toMatchObject({ status: "failed", reason: "abandoned" });
    },
  );

  it.each([
    { driver: "exited", ageMs: 60_000 },
    { driver: "reused", ageMs: 60_000 },
    { driver: "exited", phase: "validating" },
  ] as const)("repairs a dead driver without maintenance: %j", async (fixture) => {
    const run = seedRun(fixture);

    await runRegisteredCli({ register: registerUpdateCli, argv: ["update", "repair"] });

    expect(getUpdateRun(run.runId)).toMatchObject({
      status: "failed",
      phase: "finished",
      reason: "abandoned",
      steps: expect.arrayContaining([
        expect.objectContaining({ step: "reconcile:acknowledged", status: "completed" }),
      ]),
    });
    expect(listUpdateRuns({ active: true })).toEqual([]);
    expect(listUpdateRuns()).toHaveLength(1);
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.runtime.log).toHaveBeenCalledWith(
      "Gateway is healthy. Reconciled 1 abandoned update run. No maintenance or service restart was needed.",
    );
    expect(mocks.runtime.exit).not.toHaveBeenCalledWith(1);
  });

  it.each(["abandoned", "legacy-driver-expired"])(
    "exits successfully when the Gateway already reconciled the %s row",
    async (reason) => {
      const run = seedRun();
      finishUpdateRun(run.runId, { status: "failed", reason });

      await updateRepairCommand({ json: true });

      expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ reconciledRuns: [run.runId] }),
      );
      expect(getUpdateRun(run.runId)).toMatchObject({
        status: "failed",
        reason,
        steps: expect.arrayContaining([
          expect.objectContaining({ step: "reconcile:acknowledged", status: "completed" }),
        ]),
      });
      expect(mocks.finalize).not.toHaveBeenCalled();
      expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("already reconciled") }),
      );
      expect(await buildStatusUpdateRows(null)).toEqual([
        { Item: "Update run", Value: "ℹ️ OpenClaw abandoned update reconciled." },
      ]);
      await updateRepairCommand({});
      expect(mocks.finalize).toHaveBeenCalledExactlyOnceWith({}, [], undefined);
      expect(getUpdateRun(run.runId)).toMatchObject({ status: "failed", reason });
    },
  );

  it.each([-1, 0, 1])(
    "keeps the lightweight repair window separate from acknowledgment (%sms)",
    async (offset) => {
      const run = seedRun();
      vi.mocked(Date.now).mockReturnValue(now - ABANDONED_UPDATE_RUN_MS - offset);
      finishUpdateRun(run.runId, { status: "failed", reason: "abandoned" });
      vi.mocked(Date.now).mockReturnValue(now);
      const recorded = getUpdateRun(run.runId);

      await updateRepairCommand({});

      if (offset > 0) {
        expect(mocks.finalize).toHaveBeenCalledWith({}, [run.runId], undefined);
        expect(getUpdateRun(run.runId)).toEqual(recorded);
      } else {
        expect(mocks.finalize).not.toHaveBeenCalled();
        expect(getUpdateRun(run.runId)?.steps).toContainEqual(
          expect.objectContaining({ step: "reconcile:acknowledged", status: "completed" }),
        );
      }
    },
  );

  it.each(["driver activity", "newer post-core history"] as const)(
    "rechecks %s after Gateway health inspection",
    async (change) => {
      const run = seedRun({ phase: "staging" });
      mocks.readiness.mockImplementationOnce(async () => {
        if (change === "driver activity") {
          recordUpdateRunStep(run.runId, {
            step: "build",
            status: "in_progress",
            startedAtMs: now,
          });
        } else {
          const newer = seedRun({ ageMs: 60_000, phase: "activating" });
          finishUpdateRun(newer.runId, { status: "failed", reason: "abandoned" });
        }
        return { healthz: 200, readyz: 200 };
      });
      await expect(updateRepairCommand({})).rejects.toThrow(
        change === "driver activity"
          ? "remains recorded as running"
          : /openclaw update repair.*openclaw gateway stop/,
      );
      if (change === "driver activity") {
        expect(getUpdateRun(run.runId)?.status).toBe("running");
      } else {
        expect(getUpdateRun(run.runId)).toEqual(run);
        expect(mocks.runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Reconciled"));
      }
      expect(mocks.finalize).not.toHaveBeenCalled();
    },
  );

  it.each<{
    opts?: Parameters<typeof updateRepairCommand>[0];
    phase?: UpdateRunRecord["phase"];
    reconciled?: boolean;
    failedStep?: boolean;
  }>([
    { opts: { channel: "beta" } },
    { opts: { acceptCapabilities: true } },
    { phase: "activating" },
    { phase: "restarting" },
    { phase: "verifying" },
    { phase: "repairing" },
    { phase: "verifying", reconciled: true },
    { failedStep: true },
  ])(
    "retains full repair for post-core work or explicit changes: %j",
    async ({ opts = {}, phase, reconciled, failedStep }) => {
      const run = seedRun({ phase: phase === "repairing" ? "verifying" : phase });
      vi.mocked(Date.now).mockReturnValue(run.updatedAtMs);
      if (phase === "repairing") {
        recordUpdateRunPhase(run.runId, phase);
      }
      if (failedStep) {
        recordUpdateRunStep(run.runId, { step: "finalize:doctor", status: "failed" });
      }
      vi.mocked(Date.now).mockReturnValue(now);
      if (reconciled) {
        finishUpdateRun(run.runId, { status: "failed", reason: "abandoned" });
      }
      const recorded = getUpdateRun(run.runId);
      mocks.finalize.mockRejectedValueOnce(new Error("Stop the service through its owner"));
      await expect(updateRepairCommand(opts)).rejects.toThrow("Stop the service through its owner");
      expect(getUpdateRun(run.runId)).toEqual(recorded);
      if (failedStep) {
        expect(getUpdateRun(run.runId)?.status).toBe("running");
      }
      expect(mocks.finalize).toHaveBeenCalledWith(opts, [run.runId], undefined);
    },
  );

  it.each([
    { step: "activating", reason: "abandoned", acknowledged: false, overflow: false },
    { step: "finalize:plugins", reason: "doctor-failed", acknowledged: false, overflow: false },
    { step: "finalize:doctor", reason: undefined, acknowledged: false, overflow: false },
    { step: "activating", reason: "abandoned", acknowledged: true, overflow: false },
    { step: "activating", reason: "abandoned", acknowledged: false, overflow: true },
  ])(
    "checks newer post-core history before ledger-only repair: %j",
    async ({ step, reason, acknowledged, overflow }) => {
      const old = seedRun({ ageMs: ABANDONED_UPDATE_RUN_MS * 4 });
      const newer = seedRun({ ageMs: ABANDONED_UPDATE_RUN_MS * 3 });
      vi.mocked(Date.now).mockReturnValue(now - ABANDONED_UPDATE_RUN_MS * 2);
      recordUpdateRunStep(newer.runId, { step, status: "completed" });
      finishUpdateRun(newer.runId, { status: "failed", reason });
      vi.mocked(Date.now).mockReturnValue(now);
      if (acknowledged) {
        acknowledgeAbandonedUpdateRun(newer.runId);
      }
      if (overflow) {
        for (let index = 0; index < 100; index++) {
          const run = createUpdateRun({ trigger: "cli" });
          finishUpdateRun(run.runId, { status: "skipped", reason: "already-current" });
        }
      }
      const recorded = listUpdateRuns();
      if (acknowledged) {
        await updateRepairCommand({});
        expect(getUpdateRun(old.runId)).toMatchObject({ status: "failed", reason: "abandoned" });
        expect(mocks.finalize).not.toHaveBeenCalled();
      } else {
        mocks.finalize.mockRejectedValueOnce(new Error("Stop the service through its owner"));
        await expect(updateRepairCommand({})).rejects.toThrow("Stop the service through its owner");
        if (!overflow) {
          expect(mocks.finalize).toHaveBeenCalledWith({}, [old.runId, newer.runId], undefined);
        }
        expect(getUpdateRun(old.runId)).toEqual(old);
        expect(mocks.reachable).not.toHaveBeenCalled();
        expect(listUpdateRuns()).toEqual(recorded);
      }
    },
  );

  it.each([
    "newer post-core failure",
    "selected post-core marker",
    "newer preflight failure",
  ] as const)(
    "revalidates lightweight repair when %s appears before worker admission",
    async (change) => {
      vi.mocked(Date.now).mockRestore();
      const ownDriver = readUpdateRunDriver();
      if (!ownDriver) {
        throw new Error("The repair fixture requires its native process identity");
      }
      const driver = { ...ownDriver, startIdentity: String(Number(ownDriver.startIdentity) + 1) };
      expect(inspectUpdateRunDriver(driver)).toBe("dead");
      const created = createUpdateRun({ trigger: "control-ui", origin: { driver } });
      const createdAtMs = Date.now() - ABANDONED_UPDATE_RUN_MS * 2;
      openOpenClawStateDatabase()
        .db.prepare(
          "UPDATE update_runs SET created_at_ms = ?, updated_at_ms = ?, steps_json = ? WHERE run_id = ?",
        )
        .run(
          createdAtMs,
          createdAtMs,
          JSON.stringify([{ step: "requested", status: "in_progress", startedAtMs: createdAtMs }]),
          created.runId,
        );
      const before = getUpdateRun(created.runId)!;
      const createAdmission = sqliteWorkerStore.createSqliteWorkerWriteAdmission;
      let injected = false;
      let selectedAfterInjection: UpdateRunRecord | undefined;
      let added: UpdateRunRecord | undefined;
      const admission = vi
        .spyOn(sqliteWorkerStore, "createSqliteWorkerWriteAdmission")
        .mockImplementationOnce((assertCurrent, nativeLocations) => {
          const factory = createAdmission(assertCurrent, nativeLocations);
          return (operation) => {
            admission.mockRestore();
            expect(mocks.readiness).toHaveBeenCalledOnce();
            expect(getUpdateRun(created.runId)).toEqual(before);
            // The real broker enters this factory after candidate selection but before
            // dispatching the writer, so another commit can still change repair eligibility.
            if (change === "selected post-core marker") {
              recordUpdateRunStep(created.runId, {
                step: "finalize:plugins",
                status: "failed",
                detail: "Synthetic interrupted plugin convergence",
              });
            } else {
              const newer = createUpdateRun({ trigger: "cli" });
              const postCore = change === "newer post-core failure";
              recordUpdateRunStep(newer.runId, {
                step: postCore ? "finalize:doctor" : "preflight",
                status: "failed",
              });
              added = finishUpdateRun(newer.runId, {
                status: "failed",
                reason: postCore ? "doctor-failed" : "preflight-failed",
              });
            }
            selectedAfterInjection = getUpdateRun(created.runId);
            injected = true;
            return factory(operation);
          };
        });
      try {
        await runRegisteredCli({ register: registerUpdateCli, argv: ["update", "repair"] });
        expect(injected).toBe(true);
        expect(mocks.finalize).not.toHaveBeenCalled();
        if (added) {
          expect(getUpdateRun(added.runId)).toEqual(added);
        }
        expect(listUpdateRuns()).toHaveLength(added ? 2 : 1);
        if (change === "newer preflight failure") {
          expect(mocks.runtime.error).not.toHaveBeenCalled();
          expect(mocks.runtime.exit).not.toHaveBeenCalledWith(1);
          expect(getUpdateRun(created.runId)).toMatchObject({
            status: "failed",
            reason: "abandoned",
            steps: expect.arrayContaining([
              expect.objectContaining({ step: "reconcile:acknowledged", status: "completed" }),
            ]),
          });
          expect(listUpdateRuns({ active: true })).toEqual([]);
          expect(mocks.runtime.log).toHaveBeenCalledWith(
            "Gateway is healthy. Reconciled 1 abandoned update run. No maintenance or service restart was needed.",
          );
        } else {
          expect(mocks.runtime.error).toHaveBeenCalledWith(
            expect.stringContaining("needs post-core maintenance"),
          );
          expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
          expect(mocks.runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Reconciled"));
          expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
          expect(getUpdateRun(created.runId)).toEqual(selectedAfterInjection);
          expect(getUpdateRun(created.runId)?.steps).not.toContainEqual(
            expect.objectContaining({ step: "reconcile:acknowledged" }),
          );
        }
      } finally {
        admission.mockRestore();
      }
    },
  );

  it.each([
    "version mismatch",
    "build mismatch",
    "missing running build",
    "missing installed build",
    "missing installed version",
    "config",
    "plugin",
    "channel",
    "readiness",
    "handshake",
  ])("retains full repair when the serving generation is unverified: %s", async (problem) => {
    const run = seedRun();
    const root = await mocks.resolveRoot();
    if (problem === "missing installed build") {
      fs.unlinkSync(path.join(root, "dist", "build-info.json"));
    } else if (problem === "missing installed version") {
      fs.writeFileSync(path.join(root, "package.json"), "{}");
    }
    if (problem === "config") {
      mocks.readConfig.mockResolvedValue({ valid: false, config: {} });
    } else if (problem === "readiness") {
      mocks.readiness.mockResolvedValue({ healthz: 200, readyz: 503 });
    }
    mocks.reachable.mockResolvedValue({
      reachable: true,
      gatewayVersion:
        problem === "version mismatch" ? "2026.9.2" : problem === "handshake" ? "" : "2026.9.3",
      gatewayBuildId:
        problem === "build mismatch"
          ? "previous-build"
          : problem === "missing running build"
            ? null
            : "installed-build",
      activatedPluginErrors: problem === "plugin" ? [{ id: "test", error: "failed" }] : [],
      channelProbeErrors: problem === "channel" ? [{ id: "test", error: "failed" }] : [],
    });
    mocks.finalize.mockRejectedValueOnce(new Error("Stop the service through its owner"));

    await expect(updateRepairCommand({})).rejects.toThrow("Stop the service through its owner");

    expect(getUpdateRun(run.runId)).toEqual(run);
    expect(mocks.finalize).toHaveBeenCalledWith({}, [run.runId]);
    expect(mocks.runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Reconciled"));
  });

  it("does not reconcile when write admission is refused", async () => {
    const run = seedRun();
    mocks.ownershipAllowed.mockRejectedValueOnce(new Error("externally supervised"));

    await expect(updateRepairCommand({})).rejects.toThrow("externally supervised");

    expect(getUpdateRun(run.runId)).toEqual(run);
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.reachable).not.toHaveBeenCalled();
  });
});
