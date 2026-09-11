import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readConfigFileSnapshot, transformConfigFile } from "../../config/config.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import type { UpdateRecoveryBackupRef } from "../../infra/update-recovery-backup-contract.js";
import {
  inspectUpdateRecoveryBackups,
  readUpdateRecoveryConfigState,
  verifyUpdateRecoveryBackup,
} from "../../infra/update-recovery-backup.js";
import * as ledger from "../../infra/update-run-ledger.js";
import { getUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import {
  ABANDONED_UPDATE_RUN_MS,
  UPDATE_RUN_HEARTBEAT_MS,
} from "../../infra/update-run-timeouts.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withCliProcessScope } from "../runtime-cleanup-scope.js";
import * as shared from "./shared.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import * as freshDoctor from "./update-command-fresh-doctor.js";
import * as plugins from "./update-command-plugins.js";
import { UpdateFinalizationLifecycle } from "./update-finalization-lifecycle.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeSync: vi.fn(actual.writeSync) };
});

const dirs = createTempDirTracker();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("openclaw-finalize-heartbeat-"));
  vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  dirs.cleanup();
});

it.each(["doctor", "targetConfigConvergence"] as const)(
  "keeps default %s work and heartbeat alive beyond the former deadline",
  async (phase) => {
    const stopChildren = vi.fn();
    const lifecycle = new UpdateFinalizationLifecycle(false, undefined, stopChildren);
    expect(lifecycle.budget(phase)).toBeUndefined();
    lifecycle.attachLedger();
    const [initial] = listUpdateRuns();
    if (!initial) {
      throw new Error("Finalization did not create its update run.");
    }
    const work = createDeferredCore();
    const timerCount = vi.getTimerCount();
    const running = withCliProcessScope(() => lifecycle.run(phase, () => work.promise));

    await vi.advanceTimersByTimeAsync(240_000);
    expect(stopChildren).not.toHaveBeenCalled();
    expect(getUpdateRun(initial.runId)).toMatchObject({ status: "running" });
    expect(getUpdateRun(initial.runId)?.updatedAtMs).toBeGreaterThan(initial.updatedAtMs);
    work.resolve();
    await expect(running).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(timerCount);
    lifecycle.complete(0);
    expect(getUpdateRun(initial.runId)?.status).toBe("succeeded");
  },
);

it("preserves other phase defaults and explicit operator budgets", () => {
  const defaults = new UpdateFinalizationLifecycle(false, undefined, () => {});
  const explicit = new UpdateFinalizationLifecycle(false, 5_000, () => {});
  for (const [phase, budget] of [
    ["preflight", 30_000],
    ["targetConfigValidation", 30_000],
    ["configSnapshot", 30_000],
    ["plugins", 600_000],
    ["completionCache", 30_000],
    ["doctor", undefined],
    ["targetConfigConvergence", undefined],
  ] as const) {
    expect(defaults.budget(phase)).toBe(budget);
    expect(explicit.budget(phase)).toBe(5_000);
  }
});

it("reports the retained capture and recovery command on an explicit finalization deadline", async () => {
  const stopChildren = vi.fn();
  const lifecycle = new UpdateFinalizationLifecycle(true, 1_000, stopChildren);
  lifecycle.attachLedger();
  const directory = path.join(process.env.OPENCLAW_STATE_DIR!, "retained-capture");
  const manifestPath = path.join(directory, "manifest.json");
  lifecycle.updateRecoveryBackup = {
    directory,
    manifestPath,
    manifestSha256: "a".repeat(64),
  };
  const shutdown = new Error("fixture process exit");
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
    throw shutdown;
  });
  const write = vi.mocked(writeSync).mockClear();
  const work = createDeferredCore();
  const running = withCliProcessScope(() => lifecycle.run("doctor", () => work.promise));
  try {
    await expect(vi.advanceTimersByTimeAsync(1_000)).rejects.toBe(shutdown);
    expect(stopChildren).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    const json = write.mock.calls.find(([fd]) => fd === 1)?.[1];
    expect(typeof json).toBe("string");
    expect(JSON.parse(String(json))).toMatchObject({
      status: "failed",
      stuckPhase: "doctor",
      recovery: { manifestPath, command: "npx openclaw@latest doctor --fix" },
    });
    const stderr = write.mock.calls
      .filter(([fd]) => fd === 2)
      .map(([, chunk]) => chunk)
      .join("");
    expect(stderr).toContain(manifestPath);
    expect(stderr).toContain("npx openclaw@latest doctor --fix");
    expect(listUpdateRuns()[0]).toMatchObject({ status: "failed" });
  } finally {
    work.resolve();
    await running;
  }
});

it.each([false, true])(
  "renews a long finalization phase and releases its heartbeat (failure=%s)",
  async (fails) => {
    const lifecycle = new UpdateFinalizationLifecycle(false, ABANDONED_UPDATE_RUN_MS * 2, () => {});
    lifecycle.attachLedger();
    const [initial] = listUpdateRuns();
    if (!initial) {
      throw new Error("Finalization did not create its update run.");
    }
    expect(initial.origin.driver?.pid).toBe(process.pid);
    const phase = createDeferredCore();
    const timerCount = vi.getTimerCount();
    const running = lifecycle.run("plugins", () => phase.promise);
    const settled = fails
      ? expect(running).rejects.toThrow("plugin repair failed")
      : expect(running).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(ABANDONED_UPDATE_RUN_MS + UPDATE_RUN_HEARTBEAT_MS);
    const observed = getUpdateRun(initial.runId);
    expect(observed?.status).toBe("running");
    expect(observed?.updatedAtMs).toBeGreaterThan(initial.updatedAtMs + ABANDONED_UPDATE_RUN_MS);
    if (fails) {
      phase.reject(new Error("plugin repair failed"));
    } else {
      phase.resolve();
    }
    await settled;
    expect(vi.getTimerCount()).toBe(timerCount);
    const finishedPhase = getUpdateRun(initial.runId);
    await vi.advanceTimersByTimeAsync(UPDATE_RUN_HEARTBEAT_MS * 2);
    expect(getUpdateRun(initial.runId)).toEqual(finishedPhase);
    lifecycle.complete(fails ? 1 : 0);
  },
);

it("continues finalization after heartbeat errors and warns once for the run", async () => {
  const stopChildren = vi.fn();
  const lifecycle = new UpdateFinalizationLifecycle(
    false,
    ABANDONED_UPDATE_RUN_MS * 2,
    stopChildren,
  );
  lifecycle.attachLedger();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(ledger, "heartbeatUpdateRun").mockImplementation(() => {
    throw new Error("SQLITE_BUSY: database is locked");
  });
  for (const phase of ["plugins", "targetConfigConvergence"] as const) {
    const work = createDeferredCore();
    const running = lifecycle.run(phase, () => work.promise);
    await vi.advanceTimersByTimeAsync(UPDATE_RUN_HEARTBEAT_MS * 2);
    expect(stopChildren).not.toHaveBeenCalled();
    work.resolve();
    await expect(running).resolves.toBeUndefined();
  }
  lifecycle.complete(0);
  expect(listUpdateRuns()[0]?.status).toBe("succeeded");
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("SQLITE_BUSY"));
});

it.each([false, true])(
  "finalization protects both Doctor phases with one capture (post-Doctor failure=%s)",
  async (fails) => {
    vi.useRealTimers();
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await state.writeConfig({
        agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        plugins: { enabled: false },
        update: { channel: "stable" },
      });
      const initialConfig = await fs.readFile(state.configPath, "utf8");
      const original = {
        agentId: "main",
        sessionKey: "agent:main:before-finalize",
        env: state.env,
      };
      const migrated = {
        agentId: "main",
        sessionKey: "agent:main:finalize-migration",
        env: state.env,
      };
      await upsertSessionEntryCore(original, { sessionId: "original-session", updatedAt: 1 });
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawStateDatabaseForTest();
      const root = state.path("install");
      await fs.mkdir(root, { mode: 0o700 });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.3" }),
      );
      const coordinator = state.path("coordinator");
      await fs.mkdir(coordinator, { mode: 0o700 });
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(coordinator);
      vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
      vi.spyOn(shared, "tryWriteCompletionCache").mockResolvedValue("completed");
      vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      const references: UpdateRecoveryBackupRef[] = [];
      const checkCapture = async (ref: UpdateRecoveryBackupRef | undefined) => {
        expect(ref, "every finalizer Doctor needs its parent's verified capture").toBeDefined();
        if (!ref) {
          throw new Error("Missing finalizer-owned update capture");
        }
        references.push(ref);
        const manifest = await verifyUpdateRecoveryBackup(ref);
        const configEntry = manifest.entries.find(
          (entry) => entry.sourcePath === state.configPath && entry.kind === "file",
        );
        if (configEntry?.kind !== "file") {
          throw new Error("Expected captured config before requested-channel mutation");
        }
        expect(await fs.readFile(path.join(ref.directory, configEntry.archivePath), "utf8")).toBe(
          initialConfig,
        );
        const raw = await fs.readFile(state.configPath, "utf8");
        const receipts = await readUpdateRecoveryConfigState(ref, { assertOwned() {} });
        expect(receipts.configWrites).toContainEqual(
          expect.objectContaining({
            path: state.configPath,
            beforeHash: createHash("sha256").update(initialConfig).digest("hex"),
            afterHash: createHash("sha256").update(raw).digest("hex"),
            contiguous: true,
          }),
        );
      };
      vi.spyOn(freshDoctor, "runUpdateFinalizationDoctorInFreshProcess").mockImplementation(
        async (params) => {
          await checkCapture(params.updateRecoveryBackup);
          expect(params.phase).toBe("pre-plugin");
          expect((await readConfigFileSnapshot()).config.update?.channel).toBe("beta");
          await upsertSessionEntryCore(migrated, { sessionId: "doctor-migration", updatedAt: 2 });
          await closeOpenClawAgentDatabasesAsync();
        },
      );
      const pluginUpdate: plugins.PostCorePluginUpdateResult = {
        status: "ok",
        changed: true,
        sync: {
          changed: false,
          switchedToBundled: [],
          switchedToNpm: [],
          warnings: [],
          errors: [],
        },
        npm: { changed: false, outcomes: [] },
        integrityDrifts: [],
        warnings: [],
      };
      vi.spyOn(plugins, "updatePluginsAfterCoreUpdate").mockImplementation(async () => {
        await transformConfigFile({
          base: "source",
          writeOptions: {
            skipPluginValidation: true,
            skipRuntimeSnapshotRefresh: true,
            skipOutputLogs: true,
          },
          transform: (config) => ({
            nextConfig: { ...config, logging: { ...config.logging, level: "debug" } },
          }),
        });
        return pluginUpdate;
      });
      vi.spyOn(freshDoctor, "completePostCorePluginUpdate").mockImplementation(async (params) => {
        expect(params.freshDoctorRequired).toBe(true);
        await params.beforeDoctor?.();
        await checkCapture(params.updateRecoveryBackup);
        if (fails) {
          throw new Error("synthetic post-plugin Doctor failure");
        }
        return { pluginUpdate, configSnapshot: await readConfigFileSnapshot() };
      });
      const operation = updateFinalizeCommand({ yes: true, json: true, channel: "beta" });
      if (fails) {
        await expect(operation).rejects.toThrow("synthetic post-plugin Doctor failure");
      } else {
        await expect(operation).resolves.toBeUndefined();
      }
      expect(references).toHaveLength(2);
      expect(references[1]).toEqual(references[0]);
      const captures = await inspectUpdateRecoveryBackups();
      expect(captures).toHaveLength(1);
      expect(captures[0]?.ref).toEqual(references[0]);
      expect(loadSessionEntryReadOnly(original)?.sessionId).toBe("original-session");
      const run = listUpdateRuns()[0];
      expect(run?.status).toBe(fails ? "failed" : "succeeded");
      if (fails) {
        expect(loadSessionEntryReadOnly(migrated)).toBeUndefined();
        expect(await fs.readFile(state.configPath, "utf8")).toBe(initialConfig);
        expect(run?.origin.updateRecoveryCapture?.restored).toBe(true);
      } else {
        expect(loadSessionEntryReadOnly(migrated)?.sessionId).toBe("doctor-migration");
        expect(defaultRuntime.error).toHaveBeenCalledWith(
          expect.stringContaining("npx openclaw@latest doctor --fix"),
        );
        const ref = references[0];
        if (!ref) {
          throw new Error("Expected retained finalization capture");
        }
        await expect(fs.stat(path.join(ref.directory, "outcome.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    });
  },
);
