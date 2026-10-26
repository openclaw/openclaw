import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreAsync,
  findPersistedAuthProfileCredential,
  loadAuthProfileStoreForRuntime,
  resolveApiKeyForProfile,
  resolvePersistedAuthProfileOwnerAgentDir,
  saveAuthProfileStore,
} from "../agents/auth-profiles.js";
import { prepareSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import * as sqliteRead from "../agents/auth-profiles/sqlite-read.js";
import {
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import type { AuthProfileRowRead } from "../agents/auth-profiles/types.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSqliteScope } from "../config/sessions/session-accessor.sqlite-scope.js";
import * as embeddedStateLock from "../infra/embedded-state-lock.js";
import { captureNativeSignalBridge } from "../infra/embedded-state-lock.test-support.js";
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
  observe: (options: Parameters<AgentExecRunnerFixture>[0]) => void | Promise<void>,
  opts: Parameters<typeof agentExecCommand>[1] = {},
) =>
  runAgentExecWithMock("inspect", opts, createTestRuntime(), async (options) => {
    await observe(options);
    return success();
  });

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
      const createSignalBridge = embeddedStateLock.createEmbeddedStateSignalBridge;
      const signals = captureNativeSignalBridge(createSignalBridge);
      vi.spyOn(embeddedStateLock, "createEmbeddedStateSignalBridge").mockImplementationOnce(
        signals.create,
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
        try {
          pendingRows.resolve(emptyRows);
          await executing;
        } finally {
          signals.dispose();
        }
      }
    });
  });

  it("blocks stored and external CLI credentials and omits host-command secrets under --auth-env-only", async () => {
    const codexHome = tempDirs.make("openclaw-agent-exec-codex-home-");
    const normalStateDir = tempDirs.make("openclaw-agent-exec-hidden-auth-");
    const agentDir = path.join(normalStateDir, "agents", "main", "agent");
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
        OPENCLAW_STATE_DIR: normalStateDir,
        OPENAI_API_KEY: "test-openai-key",
        DATABASE_URL: "postgres://test.invalid/database",
      },
      async () => {
        saveAuthProfileStore(stored, agentDir);
        const result = await withHostExecInheritedEnvOmitted(["DATABASE_URL"], () =>
          run(
            async () => {
              const options = { allowKeychainPrompt: false, externalCliProviderIds: ["openai"] };
              expect(ensureAuthProfileStore(undefined, options).profiles).toEqual({});
              expect(loadAuthProfileStoreForRuntime(undefined, options).profiles).toEqual({});
              const request = { agentDir, profileId: "openai:stored" };
              expect(findPersistedAuthProfileCredential(request)).toBeUndefined();
              expect(resolvePersistedAuthProfileOwnerAgentDir(request)).toBeUndefined();
              const hostEnv = sanitizeHostExecEnv({ baseEnv: process.env });
              expect(hostEnv.OPENAI_API_KEY).toBeUndefined();
              expect(hostEnv.DATABASE_URL).toBeUndefined();
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
          profiles: {
            "openai:shared": { ...storedProfile, key: "shared-test-key" },
            "openai:token": { type: "token", provider: "openai", token: "shared-test-token" },
            "openai:private": { ...storedProfile, copyToAgents: false },
          },
        } satisfies Parameters<typeof setRuntimeAuthProfileStoreSnapshot>[0];
        const localStore = {
          version: 1,
          profiles: { "openai:shared": { ...storedProfile, key: "local-test-key" } },
        };
        writePersistedAuthProfileStoreRaw(sharedStore);
        writePersistedAuthProfileStoreRaw(localStore, state.agentDir());
        await prepareSharedAuthStoreOwnership(state.env);
        setRuntimeAuthProfileStoreSnapshot(sharedStore, state.agentDir());
        const result = await run(async () => {
          expect(process.env.OPENCLAW_STATE_DIR).not.toBe(state.stateDir);
          const store = await ensureAuthProfileStoreAsync(undefined, noExternal);
          expect(store.profiles).toEqual({
            ...localStore.profiles,
            "openai:token": sharedStore.profiles["openai:token"],
          });
          expect(
            (await resolveApiKeyForProfile({ store, profileId: "openai:shared", cfg: {} }))?.apiKey,
          ).toBe("local-test-key");
          saveAuthProfileStore(store);
        });
        expect(result.envelope.error).toBeUndefined();
        expect(readPersistedAuthProfileStoreRaw()).toEqual(sharedStore);
        expect(readPersistedAuthProfileStoreRaw(state.agentDir())).toEqual(localStore);
      },
    );
  });

  it("uses an overridden system-agent owner for credentials, the run, and its SQLite scope", async () => {
    const stateDir = tempDirs.make("openclaw-agent-exec-cfg-auth-");
    const customAgentDir = path.join(stateDir, "custom-home");
    await fs.mkdir(customAgentDir);
    const config = path.join(stateDir, "openclaw.json");
    await fs.writeFile(
      config,
      JSON.stringify({
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "beta" } },
          entries: { alpha: { agentDir: customAgentDir }, beta: {} },
        },
      }),
    );
    saveAuthProfileStore(stored, customAgentDir);
    const result = await run(
      async (options) => {
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
      },
      {
        config,
        configOverride: ['{"agents":{"defaults":{"systemAgent":{"agentId":"alpha"}}}}'],
      },
    );
    expect(result.exitCode).toBe(0);
  });
});
