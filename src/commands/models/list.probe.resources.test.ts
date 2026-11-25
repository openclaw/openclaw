import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as persist from "../../agents/auth-profiles.js";
import { isPendingOAuthRefreshFence } from "../../agents/auth-profiles/oauth-refresh-marker.js";
import { noteCommittedSharedAuthStoreOwnership } from "../../agents/auth-profiles/path-resolve.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../../agents/auth-profiles/persisted.js";
import * as authProfileSqlite from "../../agents/auth-profiles/sqlite.js";
import type { OAuthCredential } from "../../agents/auth-profiles/types.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getPluginInstance } from "../../plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { PluginRegistryInspectionResources } from "../../plugins/registry-inspection-resources.js";
import { createRuntimeTestRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTestModelDefinition } from "../test-runtime-config-helpers.js";
import { runAuthProbes } from "./list.probe.js";

const complete = vi.hoisted(() => vi.fn());
// mock-isolation: Keep real runtime admission and credential custody but never call a provider.
vi.mock("../../agents/simple-completion-execution.js", () => ({
  completeWithPreparedSimpleCompletionModel: complete,
}));

it.each([
  { source: "direct", status: "ok" },
  { source: "direct", status: "ok", directOAuth: true },
  { source: "direct", status: "auth" },
  { source: "profile", status: "ok" },
  { source: "profile", status: "auth" },
  { source: "direct", status: "format", output: "empty" },
  { source: "direct", status: "format", output: "thinking" },
  { source: "direct", status: "timeout" },
  { source: "profile", status: "ok", oauth: "expired" },
  { source: "profile", status: "ok", oauth: "valid" },
] as const)(
  "checks $source credentials ($status) with sessionless credential custody",
  async (scenario) => {
    const { source: credentialSource, status } = scenario;
    const state = await createOpenClawTestState({
      label: "probe-sessionless-resources",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    });
    const pluginId = "probe-resource-fixture";
    const oauth = "oauth" in scenario ? scenario.oauth : undefined;
    const provider = oauth ? "openai" : "probe-resource-provider";
    const profileProvider = credentialSource === "profile" ? provider : "unrelated-provider";
    const profileId = `${profileProvider}:stored`;
    const originalOAuth: OAuthCredential = {
      type: "oauth",
      provider,
      accountId: "synthetic-probe-account",
      access: "original-test-access",
      refresh: "original-test-refresh",
      expires: oauth === "expired" ? Date.now() - 60_000 : Date.now() + 3_600_000,
    };
    const rotatedOAuth: OAuthCredential = {
      ...originalOAuth,
      access: "rotated-test-access",
      refresh: "rotated-test-refresh",
      expires: Date.now() + 3_600_000,
    };
    let refreshCount = 0;
    let refreshOwnerFenced = false;
    let refreshPeerFenced = false;
    const refreshServer = createServer((_req, res) => {
      refreshCount++;
      const owner = loadPersistedSharedAuthProfileStore(state.env)?.profiles[profileId];
      const peer = loadPersistedAuthProfileStore(state.agentDir("historical"))?.profiles[profileId];
      refreshOwnerFenced = owner?.type === "oauth" && isPendingOAuthRefreshFence(owner);
      refreshPeerFenced = peer?.type === "oauth" && isPendingOAuthRefreshFence(peer);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rotatedOAuth));
    });
    refreshServer.listen(0, "127.0.0.1");
    await once(refreshServer, "listening");
    const refreshAddress = refreshServer.address();
    if (!refreshAddress || typeof refreshAddress === "string") {
      throw new Error("Expected the fixture refresh listener");
    }
    const pluginRoot = state.statePath("plugin");
    await state.writeJson("plugin/package.json", {
      name: pluginId,
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    });
    await state.writeJson("plugin/openclaw.plugin.json", {
      id: pluginId,
      providers: [provider],
      configSchema: { type: "object" },
    });
    const entry = await state.writeText(
      "plugin/index.cjs",
      `module.exports = { id: '${pluginId}', register(api) { api.registerProvider({ id: '${provider}', label: 'Probe fixture', auth: [], formatApiKey: c => c.access, refreshOAuth: async () => { const response = await fetch('http://127.0.0.1:${refreshAddress.port}/token'); return response.json(); } }); } };`,
    );
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: { workspace: state.workspaceDir } },
        defaults: { workspace: state.workspaceDir },
      },
      models: {
        providers: {
          [provider]: {
            api: "openai-completions",
            apiKey: "synthetic-probe-credential",
            ...("directOAuth" in scenario
              ? { auth: "oauth" as const, agentRuntime: { id: "codex" as const } }
              : {}),
            baseUrl: "https://fixture.invalid/v1",
            models: [
              createTestModelDefinition("probe-model", { name: "Probe model", maxTokens: 64 }),
            ],
          },
        },
      },
      plugins: {
        allow: [pluginId],
        load: { paths: [pluginRoot] },
        slots: { memory: "none", contextEngine: pluginId },
        entries: { [pluginId]: { enabled: true } },
      },
    };
    const credential = oauth
      ? originalOAuth
      : { type: "api_key" as const, provider: profileProvider, key: "stored-test-key" };
    await state.writeAuthProfiles({
      version: 1,
      profiles: { [profileId]: credential },
      lastGood: oauth ? undefined : { [profileProvider]: profileId },
      usageStats: oauth
        ? undefined
        : { [profileId]: { cooldownUntil: 1, cooldownReason: "rate_limit", errorCount: 2 } },
    });
    if (oauth) {
      writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env: state.env });
      noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, state.env);
      for (const agentDir of [undefined, state.agentDir(), state.agentDir("historical")]) {
        authProfileSqlite.writePersistedAuthProfileStoreRaw(
          {
            version: 1,
            profiles: agentDir === state.agentDir() ? {} : { [profileId]: originalOAuth },
          },
          agentDir,
        );
      }
    }
    const readAuth = () =>
      oauth
        ? loadPersistedSharedAuthProfileStore(state.env)
        : loadPersistedAuthProfileStore(state.agentDir());
    const authBefore = readAuth();
    await state.writeConfig(cfg);
    const builder = createRuntimeTestRegistry(createPluginRuntime());
    const record = createPluginRecord({ id: pluginId, source: entry });
    const source = new PluginRegistryInspectionResources(async () => {
      await getPluginInstance(record)?.dispose();
    });
    source.attach(builder.registry);
    const api = builder.createApi(record, { config: cfg, registrationMode: "full" });
    const contextEngine = vi.fn(() => {
      throw new Error("A connection check must not create a context engine");
    });
    source.runRegistration(pluginId, () => api.registerContextEngine(pluginId, contextEngine));
    setActivePluginRegistry(builder.registry);
    let privateDir: string | undefined;
    const timeout = new AbortController();
    const timeoutSignal = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    complete.mockImplementation(async (params) => {
      if (credentialSource === "direct") {
        expect(params.auth.apiKey).toBe("synthetic-probe-credential");
        if ("directOAuth" in scenario) {
          expect(params.auth.mode).toBe("oauth");
        }
      }
      if (oauth) {
        expect(params.auth.apiKey).toBe(
          oauth === "expired" ? rotatedOAuth.access : originalOAuth.access,
        );
      }
      expect(fs.existsSync(path.join(state.agentDir(), "sessions"))).toBe(false);
      if (status === "timeout") {
        timeout.abort(new DOMException("The operation timed out", "TimeoutError"));
      }
      return makeAssistantMessageFixture({
        content:
          status === "ok"
            ? [{ type: "text", text: "OK" }]
            : "output" in scenario && scenario.output === "thinking"
              ? [{ type: "thinking", thinking: "hidden reasoning" }]
              : [],
        provider,
        model: "probe-model",
        api: "openai-completions",
        stopReason: status === "timeout" ? "aborted" : status === "auth" ? "error" : "stop",
        errorMessage:
          status === "auth"
            ? "401 Invalid API key Authorization: Bearer sk-synthetic-private"
            : undefined,
      });
    });
    const upsert = persist.upsertAuthProfileWithLock;
    const capture = vi
      .spyOn(persist, "upsertAuthProfileWithLock")
      .mockImplementation(async (params) => {
        privateDir = params.agentDir;
        if (!privateDir) {
          throw new Error("Expected private credential directory");
        }
        const result = await upsert(params);
        expect(loadPersistedAuthProfileStore(privateDir)?.profiles[params.profileId]).toBeDefined();
        return result;
      });
    const parent = new AsyncWorkScope();
    const credentialWrites = vi.spyOn(authProfileSqlite, "writePersistedAuthProfileStoreRaw");
    const stateWrites = vi.spyOn(authProfileSqlite, "writePersistedAuthProfileStateRaw");
    try {
      const result = await parent.track(() =>
        runAuthProbes({
          cfg,
          agentId: "main",
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          providers: [provider],
          modelCandidates: [`${provider}/probe-model`],
          options: {
            provider,
            includeDirectKeys: credentialSource === "direct",
            ...(credentialSource === "profile" ? { profileIds: [profileId] } : {}),
            timeoutMs: 10_000,
            concurrency: 1,
            maxTokens: 8,
          },
        }),
      );
      await parent.drain();
      expect(result.results).toMatchObject([{ status, latencyMs: expect.any(Number) }]);
      if (status === "auth") {
        expect(result.results[0]?.error).toContain("401 Invalid API key");
        expect(result.results[0]?.error).not.toContain("sk-synthetic-private");
      }
      const authAfter = readAuth();
      if (oauth === "expired") {
        expect([refreshCount, refreshOwnerFenced, refreshPeerFenced]).toEqual([1, true, true]);
        expect(authAfter?.profiles[profileId]).toEqual(rotatedOAuth);
        expect(authAfter?.usageStats).toEqual(authBefore?.usageStats);
        expect(
          loadPersistedAuthProfileStore(state.agentDir("historical"))?.profiles[profileId],
        ).toBeUndefined();
      } else {
        expect(authAfter).toEqual(authBefore);
        if (oauth) {
          expect(refreshCount).toBe(0);
          expect([credentialWrites.mock.calls, stateWrites.mock.calls]).toEqual([[], []]);
        }
      }
      expect(contextEngine).not.toHaveBeenCalled();
      if (credentialSource === "direct") {
        expect(privateDir).toContain("openclaw-auth-probe-");
        expect(fs.existsSync(privateDir!)).toBe(false);
      } else {
        expect(privateDir).toBeUndefined();
      }
      expect(fs.existsSync(state.agentDir())).toBe(true);
    } finally {
      await parent.drain();
      for (const spy of [capture, timeoutSignal, credentialWrites, stateWrites]) {
        spy.mockRestore();
      }
      complete.mockReset();
      await source.release();
      await resetPreparedModelRuntimeSnapshotsForTest();
      clearPluginMetadataLifecycleCaches();
      resetPluginRuntimeStateForTest();
      await new Promise<void>((resolve, reject) => {
        refreshServer.close((error) => (error ? reject(error) : resolve()));
      });
      await state.cleanup();
    }
  },
);
