import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as oauthLocks from "../agents/auth-profiles/oauth-profile-lock.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import type { AgentHarness } from "../agents/harness/types.js";
import * as runtimePluginInstall from "../commands/runtime-plugin-install.js";
import { clearConfigCache } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClient } from "../gateway/server-methods/client-types.js";
import { modelsAuthLoginHandlers } from "../gateway/server-methods/models-auth-login.js";
import { whenAdmittedWizardSessionSettled } from "../gateway/server-methods/setup-admission.js";
import * as setupExecution from "../gateway/server-methods/system-agent-execution.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { createWizardSessionTracker } from "../gateway/server-wizard-sessions.js";
import * as providerChoices from "../plugins/provider-auth-choices.js";
import { resolvePluginProvidersCore } from "../plugins/providers.runtime.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { fixture, modelRef, tempDirs } from "./setup-inference-activate.test-support.js";
import {
  SetupInferenceCancelledError,
  throwIfSetupInferenceCancelled,
} from "./setup-inference-core.js";
import { saveSetupCredential } from "./setup-inference-credentials.js";
import { mockPluginRegistry, pluginRecord } from "./verified-inference.test-support.js";

afterEach(() => vi.restoreAllMocks());

function authChoice(
  providerId: string,
  appGuidedAuth: "oauth" | "device-code",
  choiceLabel = "Fixture sign-in",
) {
  return {
    pluginId: providerId,
    providerId,
    methodId: "fixture-login",
    choiceId: "fixture-login",
    choiceLabel,
    appGuidedAuth,
  };
}

it.each([false, true])("fences credential writes after OAuth lock (revoked=%s)", async (revoke) => {
  await withOpenClawTestState({ label: "setup-credential-authority" }, async (state) => {
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
  });
});

describe("native setup authority", () => {
  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
    clearConfigCache();
    vi.unstubAllEnvs();
  });

  it("blocks native Muse login after owner invalidation without abort", async ({ signal }) => {
    const setup = await fixture({ surface: "gateway" });
    const binaryPath = path.join(path.dirname(setup.configPath), "muse");
    const attemptsPath = path.join(path.dirname(setup.configPath), "muse-attempts");
    await fs.writeFile(
      binaryPath,
      `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(attemptsPath)}, "spawn\\n");
process.exit(1);
`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${path.dirname(binaryPath)}${path.delimiter}${process.env.PATH ?? ""}`);
    const muse = resolvePluginProvidersCore({
      config: { plugins: { allow: ["meta"], entries: { meta: { enabled: true } } } },
      onlyPluginIds: ["meta"],
      mode: "setup",
      workspaceDir: setup.workspace,
    })
      .find((provider) => provider.id === "meta")
      ?.auth.find((method) => method.id === "muse-code");
    assert.ok(muse, "The real Meta provider must expose Muse sign-in");
    const provider = setup.pluginRegistry.providers[0]?.provider;
    assert.ok(provider?.auth[0]);
    const entered = createDeferred();
    const release = createDeferred();
    let providerSignal: AbortSignal | undefined;
    provider.auth[0].run = async (ctx) => {
      providerSignal = ctx.signal;
      entered.resolve();
      await release.promise;
      return muse.run(ctx);
    };
    vi.spyOn(providerChoices, "resolveManifestDeclaredProviderAuthChoices").mockReturnValue([
      authChoice("openai", "oauth"),
    ]);
    const activate = setupExecution.activateGatewaySetupInference;
    vi.spyOn(setupExecution, "activateGatewaySetupInference").mockImplementation((params) =>
      setup.runWithMetadata(() => activate({ ...params, modelRef, deps: setup.deps })),
    );
    const tracker = createWizardSessionTracker();
    const controller = new AbortController();
    const client: GatewayClient = {
      connId: "native-login-owner",
      connectionSignal: controller.signal,
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        scopes: ["operator.admin"],
        client: { id: "cli", version: "test", platform: "test", mode: "cli" },
      },
    };
    const params = { sessionId: "native-login", authChoice: "openai/fixture-login" };
    const handler = modelsAuthLoginHandlers["models.authLogin"];
    assert.ok(handler);
    try {
      await handler({
        req: { type: "req", id: "native-login", method: "models.authLogin", params },
        params,
        respond: vi.fn(),
        // SAFETY: This handler only uses the real wizard tracker and config reader supplied here.
        context: { ...tracker, getRuntimeConfig: () => setup.config } as GatewayRequestContext,
        client,
        isWebchatConnect: () => false,
      });
      const session = tracker.wizardSessions.get(params.sessionId);
      assert.ok(session);
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          whenAdmittedWizardSessionSettled(session),
          "Provider login did not start",
        ),
        signal,
      );
      expect(setupExecution.activateGatewaySetupInference).toHaveBeenCalledWith(
        expect.objectContaining({ selectModel: false }),
      );
      client.invalidated = true;
      expect([controller.signal.aborted, providerSignal?.aborted]).toEqual([false, false]);
      release.resolve();
      await whenAdmittedWizardSessionSettled(session);
      expect(session.getStatus()).toBe("error");
      expect(session.getError()).toContain("authority is no longer active");
      expect(providerSignal?.aborted).toBe(false);
      await expect(fs.stat(attemptsPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(setup.run).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      for (const session of tracker.wizardSessions.values()) {
        session.cancel();
        await whenAdmittedWizardSessionSettled(session);
      }
    }
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
    const login = async () => ({ profiles: [], defaultModel: candidate, agentRuntimeId: "muse" });
    const provider: ProviderPlugin = {
      id: "meta",
      pluginId: "meta",
      label: "Meta",
      auth: [{ id: "fixture-login", label: "Muse Code", kind: "device_code", run: login }],
    };
    setup.deps.resolvePluginProviders = () => [provider];
    setup.deps.resolveManifestProviderAuthChoice = () =>
      authChoice("meta", "device-code", "Muse Code");
    mockPluginRegistry(["meta", "muse", "codex", "openai"].map((id) => pluginRecord(id)));
    vi.spyOn(runtimePluginInstall, "ensureModelSelectionRuntimePlugins").mockImplementation(
      async ({ cfg }) => ({ ok: true, cfg, codexInstalled: false }),
    );
    const reason = "Muse requires Meta's official API endpoint.";
    const supports = vi.fn<AgentHarness["supports"]>(() => ({ supported: false, reason }));
    const verifySetup = vi.fn(async () => {});
    setup.pluginRegistry.agentHarnesses.push({
      pluginId: "muse",
      source: "test",
      harness: {
        id: "muse",
        label: "Muse Code",
        authBootstrap: "harness",
        supports,
        verifySetup,
        runAttempt: async () => {
          throw new Error("Unsupported setup must not run a turn");
        },
      },
    });
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
