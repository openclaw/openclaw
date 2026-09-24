import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureAgentToolExecutionBudget } from "../agents/agent-tool-source-execution-guard.js";
import { createExternalAuthRuntime } from "../agents/auth-profiles/external-auth.js";
import { createAuthProfileStoreRuntime } from "../agents/auth-profiles/store.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { createAgentCleanupScope } from "../agents/run-cleanup-timeout.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getInstallationTarget } from "./installation-target-context.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  prepareUpdateRepairInference,
  runUpdateRepairTurn,
  withUpdateRepairEnvironment,
} from "./update-repair-agent.runtime.js";

const mocks = vi.hoisted(() => ({ entry: vi.fn(), run: vi.fn(), cleanup: vi.fn() }));
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.run }));
vi.mock("../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: mocks.entry,
}));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ acquireScopeCleanup: () => mocks.cleanup }),
}));

beforeEach(() => {
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

describe("post-failure repair execution", () => {
  it.each([
    { localOverride: false, cleanupFails: false },
    { localOverride: true, cleanupFails: false },
    { localOverride: false, cleanupFails: true },
  ])(
    "uses shared OAuth with a durable credential owner (local override: $localOverride, cleanup failure: $cleanupFails)",
    async ({ localOverride, cleanupFails }) => {
      await withOpenClawTestState({ layout: "home" }, async (state) => {
        const agentDir = state.statePath("agents", "owner", "agent");
        const auth = createAuthProfileStoreRuntime(createExternalAuthRuntime(() => []));
        const profileId = "fixture:subscription";
        auth.saveAuthProfileStore({
          version: 1,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "fixture",
              access: "synthetic-shared-access",
              refresh: "synthetic-refresh",
              expires: Date.now() + 3_600_000,
            },
          },
        });
        if (localOverride) {
          auth.saveAuthProfileStore(
            {
              version: 1,
              profiles: {
                [profileId]: { type: "token", provider: "fixture", token: "synthetic-local-token" },
              },
            },
            agentDir,
          );
        }
        const config: OpenClawConfig = {
          plugins: { enabled: false },
          agents: { entries: { owner: { agentDir } } },
          tools: { byProvider: { "fixture/denied": { deny: ["exec"] } } },
        };
        const target = { ...state, installRoot: state.workspaceDir };
        let retainedTool: (() => void) | undefined;
        mocks.run.mockImplementation(async (input: RunEmbeddedAgentParams) => {
          expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
          expect(getInstallationTarget()).toMatchObject({
            stateDir: state.stateDir,
            configPath: state.configPath,
          });
          expect(input).toMatchObject({
            agentDir,
            authProfileId: profileId,
            authProfileIdSource: "user",
            sessionPersistence: "detached",
            workspaceDir: target.installRoot,
            cwd: target.installRoot,
            codeModeOverride: false,
          });
          expect(input.sessionManager?.getSessionTarget()).toBeUndefined();
          const selected = auth.loadAuthProfileStoreForRuntime(input.agentDir, {
            readOnly: true,
            externalCli: { mode: "none" },
          }).profiles[profileId];
          expect(selected).toMatchObject(
            localOverride
              ? { type: "token", token: "synthetic-local-token" }
              : { type: "oauth", access: "synthetic-shared-access" },
          );
          retainedTool = captureAgentToolExecutionBudget();
          expect(retainedTool).toBeDefined();
          retainedTool?.();
          return { payloads: [{ text: "Repair completed." }], meta: { durationMs: 1 } };
        });
        const cleanup = createAgentCleanupScope();
        if (cleanupFails) {
          mocks.cleanup.mockRejectedValue(new Error("Synthetic process cleanup failure"));
        }
        const run = cleanup.run(() =>
          withUpdateRepairEnvironment(target, () =>
            runUpdateRepairTurn({
              target,
              route: {
                runner: "embedded",
                provider: "fixture",
                model: "repair",
                modelLabel: "fixture/repair",
                agentId: "owner",
                agentDir,
                authProfileId: profileId,
                runConfig: config,
                sourceConfig: config,
              },
              modelFallbacks: ["fixture/backup", "fixture/denied"],
              prompt: "Repair the failed update.",
              timeoutMs: 10_000,
              maxToolCalls: 1,
              signal: new AbortController().signal,
            }),
          ),
        );
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
          agentDir,
          userLockedAuthProfileId: profileId,
          fallbacksOverride: ["fixture/backup"],
        });
        expect(mocks.cleanup).toHaveBeenCalledOnce();
        expect(() => retainedTool?.()).toThrow();
      });
    },
  );

  it("refuses revoked repair authority before starting the runner", async () => {
    await withOpenClawTestState({ layout: "home" }, async (state) => {
      const config: OpenClawConfig = { plugins: { enabled: false } };
      const result = await runUpdateRepairTurn({
        target: { ...state, installRoot: state.workspaceDir },
        route: {
          runner: "embedded",
          provider: "fixture",
          model: "repair",
          modelLabel: "fixture/repair",
          agentId: "owner",
          agentDir: state.statePath("agents", "owner", "agent"),
          runConfig: config,
          sourceConfig: config,
        },
        modelFallbacks: [],
        prompt: "Repair.",
        timeoutMs: 10_000,
        maxToolCalls: 1,
        signal: new AbortController().signal,
        isCurrent: () => false,
      });
      expect(result).toMatchObject({
        status: "completed",
        toolCalls: 0,
        envelope: {
          status: "error",
          error: { message: "Repair no longer owns the failed update." },
        },
      });
      expect(mocks.run).not.toHaveBeenCalled();
      expect(mocks.entry).not.toHaveBeenCalled();
    });
  });
});

describe("repair rehearsal environment", () => {
  it("preserves a configuration failure instead of blaming model setup", async () => {
    await withOpenClawTestState({ layout: "home" }, async (state) => {
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
    });
  });

  it("keeps disposable selectors but rejects hostile overrides before child execution", async () => {
    await withOpenClawTestState({ layout: "home" }, async (state) => {
      const before = { ...process.env };
      const environment = {
        ...process.env,
        HOME: state.home,
        TMPDIR: state.root,
        OPENCLAW_HOME: state.home,
        OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
        NODE_OPTIONS: "--no-warnings",
        PATH: "/synthetic-untrusted-bin",
        LD_PRELOAD: "/synthetic-preload.so",
        DYLD_INSERT_LIBRARIES: "/synthetic-preload.dylib",
        OPENCLAW_SYNTHETIC_UNTRUSTED: "untrusted",
      };
      await expect(
        withUpdateRepairEnvironment(
          { ...state, installRoot: state.workspaceDir, environment },
          async () => {
            const keys = [
              "HOME",
              "TMPDIR",
              "OPENCLAW_HOME",
              "OPENCLAW_STATE_DIR",
              "OPENCLAW_CONFIG_PATH",
              "OPENCLAW_WORKSPACE_DIR",
              "PATH",
              "NODE_OPTIONS",
              "LD_PRELOAD",
              "DYLD_INSERT_LIBRARIES",
              "OPENCLAW_SYNTHETIC_UNTRUSTED",
              "OPENCLAW_UPDATE_RUN_HANDOFF",
            ];
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
            expect(child).toEqual({
              HOME: state.home,
              TMPDIR: state.root,
              OPENCLAW_HOME: state.home,
              OPENCLAW_STATE_DIR: state.stateDir,
              OPENCLAW_CONFIG_PATH: state.configPath,
              OPENCLAW_WORKSPACE_DIR: state.workspaceDir,
              PATH: before.PATH,
            });
            throw new Error("synthetic repair failure");
          },
        ),
      ).rejects.toThrow("synthetic repair failure");
      expect(process.env).toEqual(before);
    });
  });
});
