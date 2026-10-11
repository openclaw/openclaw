import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  ensureAuthProfileStore,
  findPersistedAuthProfileCredential,
  loadAuthProfileStoreForRuntime,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
  resolvePersistedAuthProfileOwnerAgentDir,
  saveAuthProfileStore,
} from "../agents/auth-profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import * as sqliteRead from "../agents/auth-profiles/sqlite-read.js";
import {
  inspectPersistedAuthProfileStoreRaw,
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import type { AuthProfileRowRead } from "../agents/auth-profiles/types.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSqliteScope } from "../config/sessions/session-accessor.sqlite-scope.js";
import * as embeddedStateLock from "../infra/embedded-state-lock.js";
import {
  sanitizeHostExecEnv,
  withHostExecInheritedEnvOmitted,
} from "../infra/host-env-security.js";
import { createDeferredCore } from "../shared/deferred.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { agentExecCommand } from "./agent-exec.js";
import { runAgentExecWithMock, type AgentExecRunnerFixture } from "./agent-exec.test-helpers.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const success = () => ({ payloads: [{ text: "done" }], meta: { durationMs: 1 } });
const storedProfile = { type: "api_key", provider: "openai", key: "test-key" } as const;
const stored = { version: 1, profiles: { "openai:stored": storedProfile } };
const noExternal = { externalCli: { mode: "none" }, syncExternalCli: false } as const;
const run = (
  deps: { runAgent: AgentExecRunnerFixture },
  opts: Parameters<typeof agentExecCommand>[1] = {},
) => runAgentExecWithMock("inspect", opts, createTestRuntime(), deps.runAgent);

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
});

describe("agent exec stored auth", () => {
  it("does not start a canceled retained-state agent after shared auth preparation settles", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      writeConfigMachineState("auth.sharedStore", { location: "state-db" });
      writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} });
      const stateDir = tempDirs.make("openclaw-agent-exec-canceled-auth-");
      const started = createDeferredCore();
      const pendingRows = createDeferredCore<AuthProfileRowRead>();
      const emptyRows: AuthProfileRowRead = {
        store: { status: "readable", raw: { version: 1, profiles: {} } },
        state: { status: "missing", reason: "row" },
        cacheable: true,
      };
      vi.spyOn(sqliteRead, "readSharedAuthProfileRows").mockImplementation(() => {
        started.resolve();
        return pendingRows.promise;
      });
      const signals = new EventEmitter();
      const createSignalBridge = embeddedStateLock.createEmbeddedStateSignalBridge;
      vi.spyOn(embeddedStateLock, "createEmbeddedStateSignalBridge").mockImplementation(() =>
        createSignalBridge(signals),
      );
      const runAgent = vi.fn(async () => success());
      const runtime = createTestRuntime();
      const executing = runAgentExecWithMock("inspect", { stateDir }, runtime, runAgent);
      try {
        await Promise.race([
          started.promise,
          executing.then(() => {
            throw new Error("Agent exec completed before shared auth preparation");
          }),
        ]);
        signals.emit("SIGTERM");
        pendingRows.resolve(emptyRows);
        const result = await executing;
        expect(result.exitCode).toBe(1);
        expect(runtime.exit).toHaveBeenCalledWith(143, { resetStream: process.stderr });
        expect(runAgent).not.toHaveBeenCalled();
        expect((await fs.stat(stateDir)).isDirectory()).toBe(true);
      } finally {
        pendingRows.resolve(emptyRows);
        await executing;
      }
    });
  });

  it("skips external CLI credentials and omits provider secrets from host commands", async () => {
    const codexHome = tempDirs.make("openclaw-agent-exec-codex-home-");
    await fs.writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "test-access", refresh_token: "test-refresh" },
      }),
    );
    await withEnvAsync(
      {
        CODEX_HOME: codexHome,
        OPENAI_API_KEY: "test-openai-key",
        DATABASE_URL: "postgres://test.invalid/database",
      },
      async () => {
        const result = await withHostExecInheritedEnvOmitted(["DATABASE_URL"], () =>
          run(
            {
              runAgent: async () => {
                const options = { allowKeychainPrompt: false, externalCliProviderIds: ["openai"] };
                expect(ensureAuthProfileStore(undefined, options).profiles).toEqual({});
                expect(loadAuthProfileStoreForRuntime(undefined, options).profiles).toEqual({});
                const hostEnv = sanitizeHostExecEnv({ baseEnv: process.env });
                expect(hostEnv.OPENAI_API_KEY).toBeUndefined();
                expect(hostEnv.DATABASE_URL).toBeUndefined();
                return success();
              },
            },
            { authEnvOnly: true },
          ),
        );
        expect(result.exitCode).toBe(0);
      },
    );
  });

  it("inherits portable shared credentials without copying them over local overrides", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENAI_API_KEY: undefined } },
      async (state) => {
        writeConfigMachineState("auth.sharedStore", { location: "state-db" });
        const sharedStore = {
          version: 1,
          order: { openai: ["openai:token", "openai:shared", "openai:private"] },
          usageStats: {
            "openai:token": { disabledUntil: Date.now() + 3_600_000 },
            "openai:private": { lastUsed: 123 },
          },
          profiles: {
            "openai:shared": { ...storedProfile, key: "shared-test-key" },
            "openai:token": { type: "token", provider: "openai", token: "shared-test-token" },
            "openai:private": { ...storedProfile, copyToAgents: false },
            "openai:oauth": {
              type: "oauth",
              provider: "openai",
              access: "test-access",
              refresh: "test-refresh",
              expires: Date.now() + 60_000,
              copyToAgents: true,
            },
          },
        } satisfies Parameters<typeof setRuntimeAuthProfileStoreSnapshot>[0];
        const localStore = {
          version: 1,
          profiles: { "openai:shared": { ...storedProfile, key: "local-test-key" } },
        };
        writePersistedAuthProfileStoreRaw(sharedStore);
        writePersistedAuthProfileStoreRaw(localStore, state.agentDir());
        setRuntimeAuthProfileStoreSnapshot(sharedStore, state.agentDir());
        const result = await run({
          runAgent: async () => {
            expect(process.env.OPENCLAW_STATE_DIR).not.toBe(state.stateDir);
            const store = ensureAuthProfileStore(undefined, noExternal);
            expect(Object.keys(store.profiles).toSorted()).toEqual([
              "openai:shared",
              "openai:token",
            ]);
            expect(loadAuthProfileStoreForRuntime(undefined, noExternal).profiles).toEqual(
              store.profiles,
            );
            expect(findPersistedAuthProfileCredential({ profileId: "openai:token" })).toEqual(
              sharedStore.profiles["openai:token"],
            );
            expect(store).toMatchObject({ runtimeLocalProfileIds: ["openai:shared"] });
            expect(resolveAuthProfileOrder({ store, provider: "openai", cfg: {} })).toEqual([
              "openai:shared",
              "openai:token",
            ]);
            expect(store.usageStats).toEqual({
              "openai:token": sharedStore.usageStats["openai:token"],
            });
            expect(
              (await resolveApiKeyForProfile({ store, profileId: "openai:shared", cfg: {} }))
                ?.apiKey,
            ).toBe("local-test-key");
            expect(inspectPersistedAuthProfileStoreRaw(state.agentDir()).status).toBe("readable");
            saveAuthProfileStore(store);
            return success();
          },
        });
        expect(result.envelope.error).toBeUndefined();
        expect(readPersistedAuthProfileStoreRaw()).toEqual(sharedStore);
        expect(readPersistedAuthProfileStoreRaw(state.agentDir())).toEqual(localStore);
      },
    );
  });

  it("uses one system-agent owner for credentials, the run, and its SQLite scope", async () => {
    const stateDir = tempDirs.make("openclaw-agent-exec-cfg-auth-");
    const customAgentDir = path.join(stateDir, "custom-home");
    await fs.mkdir(customAgentDir);
    const config = path.join(stateDir, "openclaw.json");
    await fs.writeFile(
      config,
      JSON.stringify({
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "alpha" } },
          entries: { alpha: { agentDir: customAgentDir }, beta: {} },
        },
      }),
    );
    saveAuthProfileStore(stored, customAgentDir);
    const result = await run(
      {
        runAgent: async (options) => {
          const agentId = typeof options.agentId === "string" ? options.agentId : "main";
          expect(agentId).toBe("alpha");
          expect(() =>
            resolveSqliteScope({
              agentId,
              defaultAgentId: "alpha",
              env: process.env,
              sessionKey: `agent:${agentId}:explicit:${String(options.sessionId)}`,
              storePath: resolveSessionStorePathCore(undefined, {
                agentId: "alpha",
                env: process.env,
              }),
            }),
          ).not.toThrow();
          expect(Object.keys(loadAuthProfileStoreForRuntime().profiles)).toContain("openai:stored");
          return success();
        },
      },
      { config },
    );
    expect(result.exitCode).toBe(0);
  });

  it("blocks direct persisted credential reads under --auth-env-only", async () => {
    const normalStateDir = tempDirs.make("openclaw-agent-exec-hidden-auth-");
    const agentDir = path.join(normalStateDir, "agents", "main", "agent");
    await withEnvAsync({ OPENCLAW_STATE_DIR: normalStateDir }, async () => {
      saveAuthProfileStore(stored, agentDir);
      const result = await run(
        {
          runAgent: async () => {
            const request = { agentDir, profileId: "openai:stored" };
            expect(findPersistedAuthProfileCredential(request)).toBeUndefined();
            expect(resolvePersistedAuthProfileOwnerAgentDir(request)).toBeUndefined();
            return success();
          },
        },
        { authEnvOnly: true },
      );
      expect(result.exitCode).toBe(0);
    });
  });
});
