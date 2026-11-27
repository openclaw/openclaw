import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { upsertAuthProfileWithLock } from "../../../agents/auth-profiles/profiles.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreWithoutExternalProfiles,
} from "../../../agents/auth-profiles/store-runtime.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderAuthMethod } from "../../../plugins/types.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { registerOpenClawAgentDatabaseReadCandidateResource } from "../../../state/openclaw-agent-db-resources.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  registerOpenClawStateDatabaseAsyncResource,
} from "../../../state/openclaw-state-db-cache.js";
import { useSessionStoreTempDirs } from "../../../test-utils/session-state-cleanup.js";
import { applyNonInteractivePluginProviderChoice } from "./auth-choice.plugin-providers.js";

const providerChoice = vi.hoisted(() => vi.fn());
vi.mock("./auth-choice.plugin-providers.runtime.js", () => ({
  authChoicePluginProvidersRuntime: {
    resolveOwningPluginIdsForProviderRef: () => ["openai"],
    resolveProviderPluginChoice: providerChoice,
    resolvePluginProviders: () => [],
  },
}));
vi.mock("../../runtime-plugin-install.js", () => ({
  ensureModelSelectionRuntimePlugins: async ({ cfg }: { cfg: OpenClawConfig }) => ({
    ok: true,
    cfg,
    codexInstalled: false,
  }),
}));

const tempDirs = useSessionStoreTempDirs(afterEach, "openclaw-noninteractive-replacement-");
afterEach(() => {
  vi.unstubAllEnvs();
});

it.each([
  { newKey: true, cleanupError: undefined },
  { newKey: false, cleanupError: undefined },
  { newKey: true, cleanupError: "EBUSY" },
  { newKey: false, cleanupError: "EPERM" },
])(
  "preserves provider outcome after database closure (new key: $newKey, cleanup: $cleanupError)",
  async ({ newKey, cleanupError }) => {
    const stateDir = tempDirs.make();
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", agentDir);
    const working = {
      type: "api_key" as const,
      provider: "openai",
      key: "working-key",
      copyToAgents: false,
      metadata: { accountId: "account-a", gatewayId: "gateway-b" },
    };
    const replacement = { ...working, key: "replacement-key" };
    await upsertAuthProfileWithLock({ profileId: "openai:default", credential: working, agentDir });
    const config: OpenClawConfig = {
      agents: {
        entries: { main: {} },
        defaults: { model: "openai/test-model@openai:default" },
      },
    };
    const before = structuredClone(config);
    const agentClosing = createDeferredCore();
    const agentClosed = createDeferredCore();
    const stateClosing = createDeferredCore();
    const stateClosed = createDeferredCore();
    let agentCloseSettled = false;
    const remove = fs.rm.bind(fs);
    let stagingRoot = "";
    let unregisterAgent = () => {};
    let unregisterState = () => {};
    const removal = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === stagingRoot && cleanupError) {
        throw Object.assign(new Error(`${cleanupError}: resource busy or locked`), {
          code: cleanupError,
        });
      }
      await remove(target, options);
    });
    let calls = 0;
    const method: ProviderAuthMethod = {
      id: "api-key",
      label: "OpenAI key",
      kind: "api_key",
      wizard: { choiceId: "openai-api-key" },
      run: async () => {
        throw new Error("Interactive setup must not run.");
      },
      runNonInteractive: async ({ agentDir: setupAgentDir }) => {
        calls += 1;
        expect(ensureAuthProfileStore(setupAgentDir).profiles["openai:default"]).toEqual(working);
        if (newKey) {
          await upsertAuthProfileWithLock({
            profileId: "openai:default",
            credential: replacement,
            agentDir: setupAgentDir,
          });
        }
        stagingRoot = path.resolve(setupAgentDir!, "../../..");
        const stateIdentity = captureOpenClawStateDatabaseReadAdmission(
          path.join(stagingRoot, "state", "openclaw.sqlite"),
        ).identity;
        unregisterAgent = registerOpenClawAgentDatabaseReadCandidateResource({
          path: path.join(setupAgentDir!, "openclaw.sqlite"),
          revoke() {},
          async close() {
            agentClosing.resolve();
            await agentClosed.promise;
            agentCloseSettled = true;
          },
        });
        unregisterState = registerOpenClawStateDatabaseAsyncResource({
          async close(identity) {
            if (identity?.key === stateIdentity.key) {
              expect(agentCloseSettled).toBe(true);
              stateClosing.resolve();
              await stateClosed.promise;
            }
          },
        });
        return config;
      },
    };
    providerChoice.mockReturnValue({
      provider: { id: "openai", pluginId: "openai", label: "OpenAI", auth: [method] },
      method,
      wizard: method.wizard,
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const operation = applyNonInteractivePluginProviderChoice({
      nextConfig: config,
      baseConfig: config,
      authChoice: "provider-plugin:openai:api-key",
      opts: newKey ? { openaiApiKey: "replacement-key" } : {},
      runtime,
      target: { agentId: "main", agentDir, workspaceDir: stateDir },
      resolveApiKey: async () => ({ key: "replacement-key", source: "flag" }),
      toApiKeyCredential: () => replacement,
    });
    let result: Awaited<typeof operation>;
    try {
      await Promise.race([agentClosing.promise, operation]);
      expect(removal).not.toHaveBeenCalledWith(stagingRoot, expect.anything());
      agentClosed.resolve();
      await Promise.race([stateClosing.promise, operation]);
      expect(removal).not.toHaveBeenCalledWith(stagingRoot, expect.anything());
      stateClosed.resolve();
      result = await operation;
      expect(removal).toHaveBeenCalledWith(stagingRoot, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 200,
      });
    } finally {
      agentClosed.resolve();
      stateClosed.resolve();
      await Promise.allSettled([operation]);
      unregisterAgent();
      unregisterState();
      removal.mockRestore();
      if (stagingRoot) {
        await remove(stagingRoot, { recursive: true, force: true });
      }
    }
    if (cleanupError) {
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining(
          `Warning: Could not remove setup credential staging directory ${stagingRoot}: ${cleanupError}`,
        ),
      );
    }
    expect(runtime.error).toHaveBeenCalledTimes(Number(Boolean(cleanupError)) + Number(newKey));
    expect(calls).toBe(1);
    expect(config).toEqual(before);
    const store = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
    expect(store.profiles["openai:default"]).toEqual(working);
    if (!newKey) {
      expect(result).toEqual(before);
      expect(store.profiles).toEqual({ "openai:default": working });
      expect(runtime.exit).not.toHaveBeenCalled();
      return;
    }
    expect(result).toBeNull();
    expect(Object.entries(store.profiles)).toContainEqual([
      expect.stringMatching(/^openai:setup-/),
      expect.objectContaining({
        key: "replacement-key",
        metadata: { accountId: "account-a", gatewayId: "gateway-b" },
        setup: expect.objectContaining({
          replacement: true,
          modelRef: "openai/test-model",
          authChoice: "openai-api-key",
        }),
      }),
    ]);
    const savedProfileId = Object.keys(store.profiles).find((id) => id !== "openai:default");
    expect(runtime.error.mock.calls.flat().join("\n")).toContain(
      `openclaw models auth activate ${savedProfileId} --agent main`,
    );
  },
);
