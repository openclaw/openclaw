import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import * as oauthLocks from "../agents/auth-profiles/oauth-profile-lock.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import type { AgentHarness } from "../agents/harness/types.js";
import * as runtimePluginInstall from "../commands/runtime-plugin-install.js";
import { clearConfigCache } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  fixture,
  modelRef,
  setupMuseProvider,
  tempDirs,
} from "./setup-inference-activate.test-support.js";
import {
  SetupInferenceCancelledError,
  throwIfSetupInferenceCancelled,
} from "./setup-inference-core.js";
import { saveSetupCredential } from "./setup-inference-credentials.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])("fences credential writes after OAuth lock (revoked=%s)", (revoke) =>
  withOpenClawTestState({ label: "setup-credential-authority" }, async (state) => {
    const config: OpenClawConfig = { agents: { entries: { main: {} } } };
    const existing = { type: "api_key" as const, provider: "fixture", key: "existing-fixture-key" };
    await state.writeAuthProfiles({ version: 1, profiles: { "fixture:existing": existing } });
    const lockEntered = createDeferred();
    const releaseLock = createDeferred();
    const withLocks = oauthLocks.withOAuthProfileLocks;
    vi.spyOn(oauthLocks, "withOAuthProfileLocks").mockImplementation(
      async (keys, operation, options) => {
        lockEntered.resolve();
        await releaseLock.promise;
        return await withLocks(keys, operation, options);
      },
    );
    let revoked = false;
    const beforePersistentEffect = vi.fn();
    const saving = saveSetupCredential({
      profile: {
        profileId: "openai:codex-cli",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "synthetic-codex-access",
          refresh: "synthetic-codex-refresh",
          expires: 4_102_444_800_000,
        },
      },
      config,
      baseConfig: config,
      agentDir: state.agentDir(),
      modelRef: "openai/fixture-model",
      pluginId: "codex",
      beforePersistentEffect,
      beforeWrite: () => throwIfSetupInferenceCancelled({ isCancelled: () => revoked }),
    });
    const settled = saving.catch(() => undefined);
    try {
      await awaitGateBeforeSettlement(
        lockEntered.promise,
        settled,
        "credential did not reach OAuth lock",
      );
      expect(beforePersistentEffect).toHaveBeenCalledOnce();
      revoked = revoke;
      releaseLock.resolve();
      await settled;
      const stored = (await loadAuthProfileStoreWithoutExternalProfilesAsync(state.agentDir()))
        .profiles;
      if (revoke) {
        await expect(saving).rejects.toBeInstanceOf(SetupInferenceCancelledError);
        expect(stored).toEqual({ "fixture:existing": existing });
      } else {
        expect(stored["fixture:existing"]).toEqual(existing);
        const saved = await saving;
        expect(stored[saved.profile.profileId]).toMatchObject({
          type: "oauth",
          provider: "openai",
          access: "synthetic-codex-access",
          setup: { modelRef: "openai/fixture-model", pluginId: "codex" },
        });
      }
    } finally {
      releaseLock.resolve();
      await settled;
    }
  }),
);

describe("native setup authority", () => {
  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
    clearConfigCache();
    vi.unstubAllEnvs();
  });

  it("rejects a Meta proxy before native setup verification or config commit", async () => {
    const setup = await fixture({ codex: true, homeScope: "user", primaryModel: modelRef });
    const candidate = "meta/muse-spark-1.3";
    const proxy = "https://proxy.example/v1";
    assert.ok(setup.config.models?.providers);
    const templateModel = setup.config.models.providers.openai?.models[0];
    assert.ok(templateModel);
    setup.config.models.providers.meta = {
      baseUrl: proxy,
      api: "openai-responses",
      models: [{ ...templateModel, id: "muse-spark-1.3", name: "Muse Spark 1.3" }],
    };
    const before = `${JSON.stringify(setup.config, null, 2)}\n`;
    await fs.writeFile(setup.configPath, before);
    clearConfigCache();
    vi.spyOn(runtimePluginInstall, "ensureModelSelectionRuntimePlugins").mockImplementation(
      async ({ cfg }) => ({ ok: true, cfg, codexInstalled: false }),
    );
    const reason = "Muse requires Meta's official API endpoint.";
    const supports = vi.fn<AgentHarness["supports"]>(() => ({ supported: false, reason }));
    const verifySetup = vi.fn(async () => {});
    setupMuseProvider(setup, candidate, { methodId: "fixture-login", supports, verifySetup });
    const result = await setup.activate("provider-auth", undefined, { modelRef: candidate });
    if (result.ok) {
      throw new Error("A native proxy route must not activate");
    }
    expect(result.error).toContain(reason);
    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "meta",
        modelId: "muse-spark-1.3",
        modelProvider: expect.objectContaining({ baseUrl: proxy, endpointOverrides: "present" }),
      }),
    );
    expect(verifySetup).not.toHaveBeenCalled();
    expect(setup.run).not.toHaveBeenCalled();
    expect(await fs.readFile(setup.configPath, "utf8")).toBe(before);
  });
});
