import { afterEach, expect, it, vi } from "vitest";
import { buildAnthropicProvider } from "../extensions/anthropic/api.js";
import { resolveAuthProfileDatabasePath } from "../src/agents/auth-profiles/sqlite.js";
import * as storeRuntime from "../src/agents/auth-profiles/store-runtime.js";
import * as storeUpdate from "../src/agents/auth-profiles/store-update.js";
import type { AuthProfileCredential } from "../src/agents/auth-profiles/types.js";
import { persistAuthProfileBatch } from "../src/agents/auth-profiles/upsert-with-lock.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  createRuntimeEnv,
  createTestWizardPrompter,
} from "../src/plugin-sdk/plugin-test-runtime.js";
import { runProviderPluginAuthMethod } from "../src/plugins/provider-auth-choice.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import { runOpenClawAgentWriteAdmission } from "../src/state/openclaw-agent-write-admission.js";
import { createOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

const token = "sk-ant-oat01-" + "synthetic".repeat(12);
const method = buildAnthropicProvider().auth.find((entry) => entry.id === "setup-token");
if (!method?.runNonInteractive) {
  throw new Error("Missing registered setup-token method");
}
const setupToken = method;
const states: Awaited<ReturnType<typeof createOpenClawTestState>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});
async function fixture() {
  const state = await createOpenClawTestState({ prefix: "anthropic-setup-token-" });
  states.push(state);
  return state;
}
async function login(
  state: Awaited<ReturnType<typeof fixture>>,
  config: OpenClawConfig,
  interactive: boolean,
  beforePersistentEffect?: () => Promise<void>,
  assertCurrent?: () => void,
  agentDir = state.agentDir(),
  tokenProfileId?: string,
) {
  if (interactive) {
    const result = await runProviderPluginAuthMethod({
      config,
      providerId: "anthropic",
      runtime: createRuntimeEnv(),
      prompter: createTestWizardPrompter(),
      method: setupToken,
      agentDir,
      workspaceDir: state.workspaceDir,
      env: state.env,
      opts: { token, tokenProfileId },
      beforePersistentEffect,
      assertCurrent,
    });
    return result.config;
  }
  return await setupToken.runNonInteractive!({
    authChoice: "setup-token",
    config,
    baseConfig: config,
    opts: { token, tokenProfileId },
    runtime: createRuntimeEnv(),
    agentDir,
    workspaceDir: state.workspaceDir,
    resolveApiKey: async () => null,
    toApiKeyCredential: () => null,
  });
}
it.each([true, false])(
  "preserves configured collisions at persistence (interactive=%s)",
  async (interactive) => {
    const state = await fixture();
    const original: AuthProfileCredential = {
      type: "api_key",
      provider: "other",
      key: "synthetic-other",
    };
    await persistAuthProfileBatch({
      agentDir: state.agentDir(),
      profiles: [{ profileId: "anthropic:default", credential: original }],
    });
    const config: OpenClawConfig = {
      auth: {
        profiles: {
          "anthropic:default": { provider: "other", mode: "api_key" },
          "anthropic:setup-token": { provider: "anthropic", mode: "api_key" },
        },
      },
    };
    const result = await login(state, config, interactive);
    const store = await storeRuntime.loadAuthProfileStoreWithoutExternalProfilesAsync(
      state.agentDir(),
    );
    expect(store.profiles["anthropic:default"]).toEqual(original);
    expect(store.profiles["anthropic:setup-token-2"]).toMatchObject({
      type: "token",
      provider: "anthropic",
      token,
    });
    expect(result?.auth?.profiles?.["anthropic:default"]).toEqual(
      config.auth!.profiles!["anthropic:default"],
    );
  },
);
it.each([true, false])("preserves compatible token mode (interactive=%s)", async (interactive) => {
  const state = await fixture();
  const config: OpenClawConfig = {
    auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "token" } } },
  };
  const result = await login(state, config, interactive);
  expect(result?.auth?.profiles?.["anthropic:default"]?.mode).toBe("token");
  expect(
    (await storeRuntime.loadAuthProfileStoreWithoutExternalProfilesAsync(state.agentDir()))
      .profiles["anthropic:default"],
  ).toMatchObject({ type: "token", token });
});
it.each([true, false])(
  "preserves compatible OAuth config mode (interactive=%s)",
  async (interactive) => {
    const state = await fixture();
    const config: OpenClawConfig = {
      auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "oauth" } } },
    };
    const result = await login(state, config, interactive);
    expect(result?.auth?.profiles?.["anthropic:default"]?.mode).toBe("oauth");
  },
);
it.each([true, false])(
  "preserves stored-only other-provider credentials (interactive=%s)",
  async (interactive) => {
    const state = await fixture();
    const original: AuthProfileCredential = {
      type: "api_key",
      provider: "other",
      key: "synthetic-stored-only",
    };
    await persistAuthProfileBatch({
      agentDir: state.agentDir(),
      profiles: [{ profileId: "anthropic:default", credential: original }],
    });
    await login(state, {}, interactive);
    expect(
      (await storeRuntime.loadAuthProfileStoreWithoutExternalProfilesAsync(state.agentDir()))
        .profiles["anthropic:default"],
    ).toEqual(original);
  },
);
it("preserves a conflicting credential committed after interactive preparation", async () => {
  const state = await fixture();
  const original: AuthProfileCredential = {
    type: "api_key",
    provider: "other",
    key: "synthetic-concurrent",
  };
  await expect(
    login(state, {}, true, async () => {
      await persistAuthProfileBatch({
        agentDir: state.agentDir(),
        profiles: [{ profileId: "anthropic:default", credential: original }],
      });
    }),
  ).rejects.toThrow(/changed.*retry/i);
  expect(
    (await storeRuntime.loadAuthProfileStoreWithoutExternalProfilesAsync(state.agentDir()))
      .profiles["anthropic:default"],
  ).toEqual(original);
});
it("rejects revoked interactive authority immediately before persistence", async () => {
  const state = await fixture();
  let current = true;
  await expect(
    login(
      state,
      {},
      true,
      async () => {
        current = false;
      },
      () => {
        if (!current) {
          throw new Error("synthetic revoked setup authority");
        }
      },
    ),
  ).rejects.toThrow("synthetic revoked setup authority");
});

const collisions: AuthProfileCredential[] = [
  { provider: "anthropic", type: "api_key", key: "synthetic-key" },
  { provider: "other", type: "token", token: "synthetic-other-token" },
  {
    provider: "other",
    type: "oauth",
    access: "synthetic-access",
    refresh: "synthetic-refresh",
    expires: 4102444800000,
  },
];
for (const interactive of [true, false]) {
  for (const shared of [true, false]) {
    it.each(collisions)(
      "preserves persisted $provider/$type collision (interactive=" +
        interactive +
        ", shared=" +
        shared +
        ")",
      async (original) => {
        const state = await fixture();
        const agentDir = state.agentDir("worker");
        await persistAuthProfileBatch({
          agentDir: shared ? undefined : agentDir,
          profiles: [{ profileId: "anthropic:default", credential: original }],
        });
        await login(state, {}, interactive, undefined, undefined, agentDir);
        const store = await storeRuntime.loadAuthProfileStoreWithoutExternalProfilesAsync(agentDir);
        expect(store.profiles["anthropic:default"]).toEqual(original);
        expect(store.profiles["anthropic:setup-token"]).toMatchObject({
          provider: "anthropic",
          type: "token",
          token,
        });
      },
    );
  }
  it("preserves explicit profile replacement (interactive=" + interactive + ")", async () => {
    const state = await fixture();
    await persistAuthProfileBatch({
      agentDir: state.agentDir(),
      profiles: [{ profileId: "anthropic:chosen", credential: collisions[0]! }],
    });
    await login(state, {}, interactive, undefined, undefined, state.agentDir(), "chosen");
    expect(
      (await storeRuntime.loadAuthProfileStoreWithoutExternalProfilesAsync(state.agentDir()))
        .profiles["anthropic:chosen"],
    ).toMatchObject({ type: "token", token });
  });
}

it.each([
  { interactive: true, shared: false, revoke: false },
  { interactive: false, shared: false, revoke: false },
  { interactive: true, shared: true, revoke: false },
  { interactive: false, shared: true, revoke: false },
  { interactive: true, shared: false, revoke: true },
])(
  "preserves a conflict during real write-admission wait (interactive=$interactive, shared=$shared, revoke=$revoke)",
  async ({ interactive, shared, revoke }) => {
    const state = await fixture();
    const agentDir = state.agentDir("worker");
    await persistAuthProfileBatch({
      profiles: [{ profileId: "shared-seed", credential: collisions[0]! }],
    });
    await persistAuthProfileBatch({
      agentDir,
      profiles: [{ profileId: "seed", credential: collisions[0]! }],
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let current = true;
    let armed = true;
    let predecessor: Promise<void> | undefined;
    const waitForPredecessor = async () => {
      if (!armed) {
        return;
      }
      armed = false;
      const held = createDeferredCore();
      predecessor = runOpenClawAgentWriteAdmission(
        { agentId: "worker", path: resolveAuthProfileDatabasePath(agentDir) },
        async () => {
          held.resolve();
          await release.promise;
          if (revoke) {
            current = false;
            return;
          }
          storeRuntime.saveAuthProfileStore(
            { version: 1, profiles: { "anthropic:default": collisions[0]! } },
            shared ? undefined : agentDir,
            { filterExternalAuthProfiles: false, syncExternalCli: false },
          );
        },
      );
      await held.promise;
    };
    if (interactive) {
      const realUpdate = storeUpdate.runAuthProfileStoreUpdate;
      vi.spyOn(storeUpdate, "runAuthProfileStoreUpdate").mockImplementation(async (params) => {
        await waitForPredecessor();
        const pending = realUpdate(params);
        entered.resolve();
        return await pending;
      });
    } else {
      const realUpdate = storeRuntime.updateAuthProfileStoreWithLock;
      vi.spyOn(storeRuntime, "updateAuthProfileStoreWithLock").mockImplementation(
        async (params) => {
          await waitForPredecessor();
          const pending = realUpdate(params);
          entered.resolve();
          return await pending;
        },
      );
    }
    const attempt = login(
      state,
      {},
      interactive,
      undefined,
      () => {
        if (!current) {
          throw new Error("synthetic revoked setup authority");
        }
      },
      agentDir,
    );
    void attempt.catch(() => {});
    try {
      await Promise.race([entered.promise, attempt]);
    } finally {
      release.resolve();
      await Promise.allSettled([attempt, ...(predecessor ? [predecessor] : [])]);
    }
    expect(armed).toBe(false);
    expect(predecessor).toBeDefined();
    await predecessor;
    const store = await storeRuntime.loadAuthProfileStoreWithoutExternalProfilesAsync(agentDir);
    if (revoke) {
      await expect(attempt).rejects.toThrow("synthetic revoked setup authority");
      expect(store.profiles["anthropic:default"]).toBeUndefined();
      return;
    }
    if (shared) {
      const sharedStore = await storeRuntime.loadAuthProfileStoreWithoutExternalProfilesAsync();
      expect(sharedStore.profiles["anthropic:default"]).toEqual(collisions[0]);
    }
    expect(store.profiles["anthropic:default"]).toEqual(collisions[0]);
    if (interactive || shared) {
      await expect(attempt).rejects.toThrow(/retry/i);
    } else {
      await expect(attempt).resolves.toBeDefined();
    }
    if (!interactive && !shared) {
      expect(store.profiles["anthropic:setup-token"]).toMatchObject({ type: "token", token });
    }
  },
);

const compatibleCredentials: AuthProfileCredential[] = [
  { provider: "anthropic", type: "token", token: "synthetic-previous-token" },
  {
    provider: "anthropic",
    type: "oauth",
    access: "synthetic-previous-access",
    refresh: "synthetic-previous-refresh",
    expires: 4102444800000,
  },
];
for (const interactive of [true, false]) {
  for (const shared of [true, false]) {
    it.each(compatibleCredentials)(
      "reuses compatible stored $type (interactive=" + interactive + ", shared=" + shared + ")",
      async (original) => {
        const state = await fixture();
        const agentDir = state.agentDir("worker");
        await persistAuthProfileBatch({
          agentDir: shared ? undefined : agentDir,
          profiles: [{ profileId: "anthropic:default", credential: original }],
        });
        const config: OpenClawConfig = {
          auth: {
            profiles: { "anthropic:default": { provider: "anthropic", mode: original.type } },
          },
        };
        const result = await login(state, config, interactive, undefined, undefined, agentDir);
        const store = await storeRuntime.loadAuthProfileStoreWithoutExternalProfilesAsync(agentDir);
        expect(store.profiles["anthropic:default"]).toMatchObject({ type: "token", token });
        expect(result?.auth?.profiles?.["anthropic:default"]?.mode).toBe(original.type);
      },
    );
  }
}
