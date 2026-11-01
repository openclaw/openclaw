import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureAgentToolExecutionBudget,
  captureAgentToolSourceExecutionGuard,
} from "../agents/agent-tool-source-execution-guard.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { createAgentCleanupScope } from "../agents/run-cleanup-timeout.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getBoundLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { resolveManagedUpdateLeaseDatabasePath } from "./update-managed-service-handoff-lease.js";
import {
  prepareUpdateRepairInference,
  runUpdateRepairTurn,
  withUpdateRepairEnvironment,
} from "./update-repair-agent.runtime.js";
import { repairTurnInput } from "./update-repair-agent.test-support.js";

const mocks = vi.hoisted(() => ({
  entry: vi.fn(),
  run: vi.fn(),
  cleanup: vi.fn(),
  handoff: undefined as ReturnType<typeof createManagedHandoffTestBinding> | undefined,
}));
vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: () => {
    if (!mocks.handoff) {
      throw new Error("Private handoff binding required");
    }
    mocks.handoff.assertPath();
    return mocks.handoff.directory;
  },
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  mocks.handoff = undefined;
});
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.run }));
vi.mock("../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: mocks.entry,
}));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ acquireScopeCleanup: () => mocks.cleanup }),
}));

beforeEach(() => {
  mocks.handoff = createManagedHandoffTestBinding(tempDirs.make("repair-runtime-handoff-"));
  vi.stubEnv(
    "NODE_OPTIONS",
    [process.env.NODE_OPTIONS, mocks.handoff.nodeOption].filter(Boolean).join(" "),
  );
  mocks.handoff.assertPath(resolveManagedUpdateLeaseDatabasePath());
  mocks.run.mockReset();
  mocks.cleanup.mockReset().mockResolvedValue(undefined);
  mocks.entry
    .mockReset()
    .mockImplementation(
      async (params: {
        selection: { provider: string; model: string };
        runCandidate: (
          provider: string,
          model: string,
          options: { agentHarnessRuntimeOverride: string },
        ) => Promise<unknown>;
      }) => {
        const { provider, model } = params.selection;
        const result = await params.runCandidate(provider, model, {
          agentHarnessRuntimeOverride: "openclaw",
        });
        return { result, provider, model, terminal: { outcome: { status: "ok" } } };
      },
    );
});

const repairTurn = (...args: Parameters<typeof repairTurnInput>) =>
  runUpdateRepairTurn(repairTurnInput(...args));

it.each([
  { cleanupFails: false, borrowedOwner: true },
  { cleanupFails: true, borrowedOwner: false },
])(
  "retires repair resources without closing borrowed ownership (cleanup failure: $cleanupFails, borrowed owner: $borrowedOwner)",
  ({ cleanupFails, borrowedOwner }) =>
    withOpenClawTestState({ layout: "home" }, async (state) => {
      const host = borrowedOwner ? new LegacyPluginSdkResourceHost() : undefined;
      if (host) {
        const scheduler = createTestGatewayScheduler();
        host.bindScheduler(scheduler);
        onTestFinished(async () => {
          await scheduler.stop();
          await host.close();
        });
      }
      const config: OpenClawConfig = {
        plugins: { enabled: false },
        tools: { byProvider: { "fixture/denied": { deny: ["exec"] } } },
      };
      let retainedTool: (() => void) | undefined;
      mocks.run.mockImplementation(async (input: RunEmbeddedAgentParams) => {
        if (host) {
          expect(getBoundLegacyPluginSdkResourceHost()).toBe(host);
        }
        expect(input.sessionPersistence).toBe("detached");
        expect(input.sessionManager?.getSessionTarget()).toBeUndefined();
        retainedTool = captureAgentToolExecutionBudget();
        expect(retainedTool).toBeDefined();
        retainedTool?.();
        return { payloads: [{ text: "Repair completed." }], meta: { durationMs: 1 } };
      });
      const cleanup = createAgentCleanupScope();
      if (cleanupFails) {
        mocks.cleanup.mockRejectedValue(new Error("Synthetic process cleanup failure"));
      }
      const execute = () =>
        cleanup.run(() =>
          repairTurn(state, { config, modelFallbacks: ["fixture/backup", "fixture/denied"] }),
        );
      const run = host ? host.run(execute) : execute();
      if (cleanupFails) {
        await expect(run).rejects.toThrow("Synthetic process cleanup failure");
        expect(cleanup.outcome).toBe("uncertain");
      } else {
        expect(await run).toMatchObject({
          status: "completed",
          toolCalls: 1,
          envelope: { final: "Repair completed.", status: "ok" },
        });
        expect(cleanup.outcome).toBe("closed");
      }
      expect(mocks.entry.mock.calls[0]?.[0].selection).toMatchObject({
        fallbacksOverride: ["fixture/backup"],
      });
      expect(mocks.cleanup).toHaveBeenCalledOnce();
      expect(() => retainedTool?.()).toThrow();
      if (host) {
        const scheduler = host.scheduler;
        expect(scheduler.signal.aborted).toBe(false);
        await scheduler.stop();
        await expect(host.run(execute)).rejects.toMatchObject({ name: "AbortError" });
        expect(mocks.run).toHaveBeenCalledOnce();
      }
    }),
);

it.each(["process", "sdk"] as const)(
  "preserves both %s and database cleanup failures and refuses clean completion",
  (owner) =>
    withOpenClawTestState({ layout: "home" }, async (state) => {
      const processFailure = new Error("Synthetic process cleanup failure");
      const databaseFailure = new Error("Synthetic database cleanup failure");
      const close = vi.fn().mockRejectedValueOnce(databaseFailure).mockResolvedValue(undefined);
      let resources: ReturnType<typeof getOpenClawDatabaseMaintenanceScope>;
      mocks.run.mockImplementation(async () => {
        resources = getOpenClawDatabaseMaintenanceScope();
        expect(resources).toBeDefined();
        resources!.own({}, "agent-resources", close);
        if (owner === "sdk") {
          const host = getBoundLegacyPluginSdkResourceHost();
          expect(host).toBeDefined();
          host!.adopt(
            {},
            {
              release: async () => {
                throw processFailure;
              },
            },
          );
        }
        return { meta: { durationMs: 1 } };
      });
      if (owner === "process") {
        mocks.cleanup.mockRejectedValueOnce(processFailure);
      }
      const cleanup = createAgentCleanupScope();
      try {
        await expect(cleanup.run(() => repairTurn(state))).rejects.toMatchObject({
          message:
            owner === "process"
              ? "Repair turn and database resource cleanup failed."
              : "Repair SDK and database resource cleanup failed.",
          errors: [
            owner === "process" ? processFailure : { errors: [processFailure] },
            databaseFailure,
          ],
        });
        expect(cleanup.outcome).toBe("uncertain");
        expect(close).toHaveBeenCalledOnce();
      } finally {
        // The fixture owns the synthetic refusal and must retire it after the assertion.
        close.mockReset().mockResolvedValue(undefined);
        await resources?.close();
      }
    }),
);

it("refuses revoked repair authority before starting the runner", () =>
  withOpenClawTestState({ layout: "home" }, async (state) => {
    const result = await repairTurn(state, { isCurrent: () => false });
    expect(result).toMatchObject({
      status: "completed",
      toolCalls: 0,
      envelope: { status: "error", error: { message: "Repair no longer owns the failed update." } },
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.entry).not.toHaveBeenCalled();
  }));

it("keeps full authority at tool effect guards when preparation uses live checks", () =>
  withOpenClawTestState({ layout: "home" }, async (state) => {
    let current = true;
    mocks.run.mockImplementation(async () => {
      captureAgentToolExecutionBudget()?.();
      const beforeEffect = captureAgentToolSourceExecutionGuard();
      expect(beforeEffect).not.toThrow();
      // Revocation during a tool's own awaits must stop its final write or spawn.
      current = false;
      expect(beforeEffect).toThrow(/^Agent tool execution scope is no longer active$/u);
      return { payloads: [{ text: "Stopped." }], meta: { durationMs: 1 } };
    });
    const result = await repairTurn(state, {
      isCurrent: () => current,
      isLive: () => true,
    });
    expect(result).toMatchObject({
      status: "completed",
      toolCalls: 1,
      envelope: { final: "Stopped.", status: "ok" },
    });
  }));
it("preserves a configuration failure instead of blaming model setup", () =>
  withOpenClawTestState({ layout: "home" }, async (state) => {
    await state.writeConfig({ plugins: { enabled: false } });
    const location = state.statePath("state", "openclaw.sqlite");
    await fs.mkdir(path.dirname(location), { recursive: true });
    const database = openNodeSqliteDatabase(location);
    database.exec("PRAGMA user_version = 999999");
    database.close();
    await expect(
      withUpdateRepairEnvironment({ ...state, installRoot: state.workspaceDir }, () =>
        prepareUpdateRepairInference(new AbortController().signal, 1_000),
      ),
    ).rejects.toThrow(/newer schema version 999999/u);
  }));

it("keeps disposable selectors but rejects hostile overrides before child execution", () =>
  withOpenClawTestState({ layout: "home" }, async (state) => {
    const before = { ...process.env };
    const selectors = { HOME: state.home, TMPDIR: state.root, OPENCLAW_HOME: state.home };
    const expected = {
      ...selectors,
      OPENCLAW_STATE_DIR: state.stateDir,
      OPENCLAW_CONFIG_PATH: state.configPath,
      OPENCLAW_WORKSPACE_DIR: state.workspaceDir,
      PATH: before.PATH,
    };
    const overrides = {
      ...selectors,
      OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
      NODE_OPTIONS: "--no-warnings",
      PATH: "/synthetic-untrusted-bin",
      LD_PRELOAD: "/synthetic-preload.so",
      DYLD_INSERT_LIBRARIES: "/synthetic-preload.dylib",
      OPENCLAW_SYNTHETIC_UNTRUSTED: "untrusted",
    };
    await expect(
      withUpdateRepairEnvironment(
        {
          ...state,
          installRoot: state.workspaceDir,
          environment: { ...process.env, ...overrides },
        },
        async () => {
          const keys = [...new Set([...Object.keys(expected), ...Object.keys(overrides)])];
          const child = JSON.parse(
            execFileSync(
              process.execPath,
              [
                "-e",
                `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]]))))`,
              ],
              { encoding: "utf8" },
            ),
          );
          expect(child).toEqual(expected);
          throw new Error("synthetic repair failure");
        },
      ),
    ).rejects.toThrow("synthetic repair failure");
    expect(process.env).toEqual(before);
  }));
