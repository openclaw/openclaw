import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { buildAuthHealthSummary } from "../agents/auth-health.js";
import { resolveApiKeyForProfile } from "../agents/auth-profiles/oauth.js";
import { resolveAuthProfileOrder } from "../agents/auth-profiles/order.js";
import { resolveAuthProfilePortability } from "../agents/auth-profiles/portability.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import { upsertAuthProfileWithLock } from "../agents/auth-profiles/upsert-with-lock.js";
import { fingerprintResolvedProviderAuth } from "../agents/execution-auth-binding.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import { buildAllowedModelSet } from "../agents/model-selection.js";
import { ensureOnboardingAgent } from "../commands/onboard-agent.js";
import { hasResolvedRosterBeforeMigrations } from "../config/agent-roster-provenance.js";
import { clearConfigCache, readConfigFileSnapshot } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import { persistProviderAuthProfilesAfterLogin } from "../plugins/provider-auth-persistence.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { WizardCancelledError, WizardNavigationError } from "../wizard/prompts.js";
import { listSystemAgentAuditEntriesForTests } from "./audit.test-support.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import {
  credential,
  fixture,
  modelRef,
  tempDirs,
} from "./setup-inference-activate.test-support.js";
import {
  SetupInferenceActivationIndeterminateError,
  SetupInferenceActivationUnavailableError,
  SetupInferenceCancelledError,
  SetupInferenceOwnerDriftError,
} from "./setup-inference-core.js";
import * as credentialActivation from "./setup-inference-credential-access.js";
import { saveSetupCredential } from "./setup-inference-credentials.js";
import * as activationTransition from "./setup-inference-transition.js";
import { codexRuntimeArtifactAuth } from "./verified-inference.test-support.js";

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
  clearConfigCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("setup activation credentials and configuration", () => {
  it.each([
    { target: "utility" as const, requested: undefined },
    { target: undefined, requested: "utility" as const },
  ])(
    "rejects mismatched setup-role acknowledgement before login ($target/$requested)",
    async ({ target, requested }) => {
      const setup = await fixture({ modelTarget: target });
      const result = await setup.activate("provider-auth", undefined, { modelTarget: requested });
      expect(result).toMatchObject({ ok: false, status: "unavailable" });
      expect(setup.login).not.toHaveBeenCalled();
      expect(setup.run).not.toHaveBeenCalled();
      expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
    },
  );

  it.each([
    { primaryModel: undefined, fail: false },
    { primaryModel: "stable/working-model", fail: false },
    { primaryModel: "stable/working-model", fail: true },
  ])(
    "isolates utility activation from primary $primaryModel (failure: $fail)",
    async ({ primaryModel, fail }) => {
      const setup = await fixture({ modelTarget: "utility", primaryModel });
      if (fail) {
        setup.run.mockRejectedValueOnce(new Error("Utility inference unavailable"));
      }
      const result = await setup.activate();
      expect(result).toMatchObject({ ok: !fail });
      const saved = await readConfigFileSnapshot();
      expect(saved.sourceConfig.agents?.defaults?.model).toEqual(
        setup.config.agents?.defaults?.model,
      );
      if (fail) {
        expect(saved.sourceConfig.agents?.defaults?.utilityModel).toBeUndefined();
      } else {
        expect(result).toMatchObject({ modelTarget: "utility", modelRef });
        expect(saved.sourceConfig.agents?.defaults?.utilityModel).toContain(modelRef);
        expect(setup.run.mock.calls[0]?.[0]).toMatchObject({
          provider: "openai",
          model: "gpt-5.4-mini",
        });
      }
    },
  );

  it.each([true, false])(
    "signs in before verifying an isolated detected Codex installation (fresh: %s)",
    async (fresh) => {
      const setup = await fixture({ codex: true, fresh, subscription: true });
      const result = await setup.activate("codex-cli");
      expect(setup.login).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ ok: true });
      expect(setup.run).toHaveBeenCalledOnce();
      expect(setup.run.mock.calls[0]?.[0]).toMatchObject({
        authProfileId: setup.readProfile()?.[0],
        authProfileIdSource: "user",
        allowAuthProfileFallback: false,
        agentHarnessRuntimeOverride: "codex",
      });
      const saved = await readConfigFileSnapshot();
      expect(saved.config.plugins?.entries?.codex?.config?.appServer).not.toHaveProperty(
        "homeScope",
        "user",
      );
      expect(setup.readProfile()?.[1].setup).toBeUndefined();
    },
  );
  it("preserves explicit native user-home setup without importing or starting host sign-in", async () => {
    const setup = await fixture({ codex: true, homeScope: "user" });
    const nativeAuth = {
      apiKey: "fixture-native-key",
      source: "Codex native login",
      mode: "api-key" as const,
    };
    setup.deps.resolveApiKeyForProvider = async () => nativeAuth;
    const readNativeKey = vi.fn(() => credential);
    setup.deps.readCodexCliActiveApiKey = readNativeKey;
    setup.run.mockImplementation(async (params) => {
      expect(params.authProfileId).toBeUndefined();
      expect(params.config?.plugins?.entries?.codex?.config?.appServer).toMatchObject({
        homeScope: "user",
      });
      params.onSuccessfulAuthBinding?.({
        agentHarnessId: "codex",
        authFingerprint: fingerprintResolvedProviderAuth(nativeAuth),
        modelId: "gpt-5.4-mini",
        modelApi: "openai-responses",
        runtimeOwnerKind: "plugin-harness",
        runtimeOwnerId: "codex",
        ...codexRuntimeArtifactAuth,
      });
      return {
        payloads: [{ text: "OK" }],
        meta: {
          durationMs: 1,
          executionTrace: { winnerProvider: "openai", winnerModel: "gpt-5.4-mini" },
        },
      };
    });
    const result = await setup.activate("codex-cli");
    expect(result).toMatchObject({ ok: true });
    expect(setup.login).not.toHaveBeenCalled();
    expect(readNativeKey).not.toHaveBeenCalled();
    expect(setup.readProfile()).toBeUndefined();
    expect(
      (await readConfigFileSnapshot()).config.plugins?.entries?.codex?.config?.appServer,
    ).toMatchObject({ homeScope: "user" });
  });

  it("cancels detected Codex sign-in without verification or promotion", async () => {
    const controller = new AbortController();
    const setup = await fixture({ codex: true, signal: controller.signal });
    setup.login.mockImplementationOnce(async () => {
      controller.abort();
      throw new WizardCancelledError();
    });
    await expect(setup.activate("codex-cli")).resolves.toMatchObject({ ok: false });
    expect(setup.login).toHaveBeenCalledOnce();
    expect(setup.run).not.toHaveBeenCalled();
    expect(setup.readProfile()).toBeUndefined();
    expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
  });

  it("reuses an existing OpenClaw credential for detected Codex without another login", async () => {
    const setup = await fixture({ codex: true });
    await persistProviderAuthProfilesAfterLogin({
      config: setup.config,
      agentDir: setup.agentDir,
      profiles: [{ profileId: "openai:existing", credential }],
    });
    const result = await setup.activate("codex-cli");
    expect(result).toMatchObject({ ok: true });
    expect(setup.login).not.toHaveBeenCalled();
    expect(setup.run.mock.calls[0]?.[0].authProfileId).toBe("openai:existing");
  });

  it("retries a saved Codex sign-in after failed verification without another login", async () => {
    const setup = await fixture({ codex: true });
    setup.run.mockRejectedValueOnce(new Error("fixture provider unavailable"));
    const rejected = await setup.activate("codex-cli");
    expect(rejected).toMatchObject({ ok: false });
    expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
    const saved = setup.readProfile();
    assert.ok(saved);
    expect(saved[1].setup?.agentRuntimeId).toBe("codex");
    expect(JSON.parse(saved[1].setup!.configJson).plugins.entries.codex.enabled).toBe(true);
    const retry = await setup.activate(`saved-auth:${encodeURIComponent(saved[0])}`, true);
    expect(retry).toMatchObject({ ok: true });
    expect(setup.login).toHaveBeenCalledOnce();
    expect(setup.run).toHaveBeenCalledTimes(2);
    expect(setup.run.mock.calls[1]?.[0].agentHarnessRuntimeOverride).toBe("codex");
  });

  it("retains the detected Codex API-key setup path without guided login", async () => {
    const setup = await fixture({ codex: true });
    setup.deps.readCodexCliActiveApiKey = () => credential;
    const result = await setup.activate("codex-cli");
    expect(result).toMatchObject({ ok: true });
    expect(setup.login).not.toHaveBeenCalled();
    expect(setup.run).toHaveBeenCalledOnce();
    expect(setup.readProfile()?.[1]).toMatchObject(credential);
  });

  it.each(["abort", "replacement"] as const)(
    "does not promote a SecretRef when %s revokes final activation revalidation",
    async (revocation) => {
      const controller = new AbortController();
      const setup = await fixture({ secretRef: true, signal: controller.signal });
      const activatePrepared = credentialActivation.activatePreparedSetupCredential;
      const revoked = vi.fn();
      vi.spyOn(credentialActivation, "activatePreparedSetupCredential").mockImplementation(
        (ctx, profileId, source, runtimeCredential, revalidate, assertCurrent) =>
          activatePrepared(
            ctx,
            profileId,
            source,
            runtimeCredential,
            async () => {
              await revalidate();
              expect(
                loadAuthProfileStoreWithoutExternalProfiles(setup.agentDir).profiles[profileId]
                  ?.setup,
              ).toBeDefined();
              if (revocation === "abort") {
                controller.abort();
              } else {
                expect(
                  await upsertAuthProfileWithLock({
                    agentDir: setup.agentDir,
                    profileId,
                    credential: {
                      ...source,
                      type: "api_key",
                      keyRef: {
                        source: "env",
                        provider: "default",
                        id: "UNREAD_REPLACEMENT_FIXTURE",
                      },
                    },
                  }),
                ).not.toBeNull();
                expect(
                  await upsertAuthProfileWithLock({
                    agentDir: setup.agentDir,
                    profileId,
                    credential: source,
                  }),
                ).not.toBeNull();
              }
              revoked();
            },
            assertCurrent,
          ),
      );
      const result = await setup.activate();
      expect(revoked).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ ok: false });
      expect(setup.readProfile()?.[1].setup).toBeDefined();
      expect(setup.readProfile()?.[1]).not.toHaveProperty("key");
      expect(setup.run).toHaveBeenCalledOnce();
    },
  );

  it("offers matching saved registrations for interactive setup", async () => {
    const setup = await fixture();
    vi.mocked(setup.prompter.confirm).mockImplementation(
      async ({ message }) => message === "Connection verified. Activate this saved sign-in?",
    );
    const savedCredential = {
      type: "oauth",
      provider: "openai",
      access: "synthetic-expired-access",
      refresh: "synthetic-saved-refresh",
      expires: 1,
      clientId: "saved-registration",
      authorizationScope: "openid profile resource.invoke offline_access",
    } as const;
    await upsertAuthProfileWithLock({
      profileId: "openai:saved",
      credential: savedCredential,
      agentDir: setup.agentDir,
    });
    await upsertAuthProfileWithLock({
      profileId: "other:saved",
      credential: { ...savedCredential, provider: "other" },
      agentDir: setup.agentDir,
    });

    const result = await setup.activate();

    expect(result).toMatchObject({ ok: true });
    expect(setup.prompter.confirm).toHaveBeenCalledWith({
      message: "Connection verified. Activate this saved sign-in?",
      initialValue: true,
    });
    expect(setup.login).toHaveBeenCalledWith(
      expect.objectContaining({
        existingProfiles: [{ profileId: "openai:saved", credential: savedCredential }],
      }),
    );
    expect(
      loadAuthProfileStoreWithoutExternalProfiles(setup.agentDir).profiles["openai:saved"],
    ).toEqual(savedCredential);
  });

  it.each([false, true])(
    "preserves first-team provisioning across provider activation (rejected: %s)",
    async (rejected) => {
      const setup = await fixture({ fresh: true });
      if (rejected) {
        setup.run.mockRejectedValueOnce(new Error("fixture provider unavailable"));
      }
      const result = await setup.activate();
      expect(result).toMatchObject({ ok: !rejected });
      const activated = await readConfigFileSnapshot();
      expect(hasResolvedRosterBeforeMigrations(activated)).toBe(false);
      if (rejected) {
        expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
        expect(await fs.readdir(path.dirname(setup.workspace))).not.toContain("workspace");
        return;
      }
      const created = await ensureOnboardingAgent({
        config: activated.sourceConfig,
        baseConfig: activated.sourceConfig,
        workspace: setup.workspace,
        firstAgent: { name: "coordinator", team: true },
        expectedConfigHash: activated.hash ?? null,
      });
      expect(created.createdAgent).toBe(true);
      expect(created.createdAgentIds).toEqual(["coordinator", "researcher", "writer", "reviewer"]);
      for (const agentId of created.createdAgentIds ?? []) {
        const modelId = modelRef.slice("openai/".length);
        expect(
          resolveModelRuntimePolicy({
            config: created.config,
            agentId,
            provider: "openai",
            modelId,
          }).policy?.id,
        ).toBe("openclaw");
        expect(
          (
            await setup.resolveAuth({
              provider: "openai",
              cfg: created.config,
              agentDir: resolveAgentDir(created.config, agentId),
              workspaceDir: path.join(setup.workspace, agentId),
              profileId: setup.readProfile()?.[0],
              lockedProfile: true,
              modelId,
              modelApi: "openai-responses",
            })
          ).profileId,
        ).toBe(setup.readProfile()?.[0]);
      }
      expect(
        buildAllowedModelSet({
          cfg: created.config,
          catalog: [],
          defaultProvider: "openai",
        }).allowAny,
      ).toBe(true);
      expect(created.config.agents?.defaults?.model).toBe(
        `${modelRef}@${setup.readProfile()?.[0]}`,
      );
    },
  );

  it.each([
    {
      name: "matching-last",
      matching: true,
      expectedCredentials: [credential],
      expectedTurns: 1,
    },
    { name: "missing-match", matching: false, expectedCredentials: [], expectedTurns: 0 },
  ])(
    "saves only the selected provider credential ($name)",
    async ({ matching, expectedCredentials, expectedTurns }) => {
      const unrelated = {
        profileId: "anthropic:unrelated",
        credential: {
          type: "api_key",
          provider: "anthropic",
          key: "unrelated-fixture-key",
        } as const,
      };
      const setup = await fixture({
        profiles: matching ? [unrelated, { profileId: "openai:fixture", credential }] : [unrelated],
      });
      setup.run.mockImplementation(async (params) => {
        expect(
          Object.values(loadAuthProfileStoreWithoutExternalProfiles(setup.agentDir).profiles),
        ).toEqual([expect.objectContaining(credential)]);
        return setup.reply(params);
      });

      const result = await setup.activate();

      expect(result).toMatchObject({ ok: matching });
      expect(
        Object.values(loadAuthProfileStoreWithoutExternalProfiles(setup.agentDir).profiles),
      ).toEqual(expectedCredentials);
      expect(setup.run).toHaveBeenCalledTimes(expectedTurns);
      if (!matching) {
        expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
      }
    },
  );

  it.each([
    { name: "existing provider", localService: false, addProviderDuringLogin: false },
    { name: "local service", localService: true, addProviderDuringLogin: false },
    { name: "new provider", localService: false, addProviderDuringLogin: true },
  ])(
    "saves the credential before one tool-free turn and commits after success ($name)",
    async ({ localService, addProviderDuringLogin }) => {
      const setup = await fixture({ localService, addProviderDuringLogin });
      setup.run.mockImplementation(async (params) => {
        expect(setup.readProfile()?.[1]).toMatchObject(credential);
        expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
        expect(params.disableTools).toBe(true);
        expect(resolveAgentModelPrimaryValue(params.config?.agents?.defaults?.model)).toContain(
          modelRef,
        );
        return setup.reply(params);
      });

      const result = await setup.activate();
      expect(result).toMatchObject({ ok: true, modelRef });
      expect(setup.readProfile()?.[1]).not.toHaveProperty("setup");

      expect(setup.run).toHaveBeenCalledOnce();
      expect(setup.login).toHaveBeenCalledOnce();
      const persisted = await readConfigFileSnapshot();
      expect(persisted.valid).toBe(true);
      expect(resolveAgentModelPrimaryValue(persisted.sourceConfig.agents?.defaults?.model)).toBe(
        `${modelRef}@${setup.readProfile()?.[0]}`,
      );
    },
  );

  it("records persisted root hashes when setup retains an unrelated include", async () => {
    const setup = await fixture({ surface: "gateway" });
    const includePath = path.join(path.dirname(setup.configPath), "logging.json5");
    const included = '{level:"warn"}\n';
    const before = `${JSON.stringify({ ...setup.config, logging: { $include: "./logging.json5" } })}\n`;
    await fs.writeFile(includePath, included);
    await fs.writeFile(setup.configPath, before);
    clearConfigCache();
    const beforeSnapshot = await readConfigFileSnapshot();

    const result = await setup.activate();

    expect(result).toMatchObject({ ok: true, modelRef });
    const after = await fs.readFile(setup.configPath, "utf8");
    const afterSnapshot = await readConfigFileSnapshot();
    expect(after).not.toBe(before);
    expect(afterSnapshot.parsed).toMatchObject({ logging: { $include: "./logging.json5" } });
    expect(await fs.readFile(includePath, "utf8")).toBe(included);
    const entries = listSystemAgentAuditEntriesForTests();
    expect(entries).toHaveLength(1);
    const entry = entries[0]?.value;
    assert.ok(entry);
    expect(entry).toMatchObject({
      operation: "openclaw.setup",
      configPath: setup.configPath,
      configHashBefore: createHash("sha256").update(before).digest("hex"),
      configHashAfter: createHash("sha256").update(after).digest("hex"),
    });
    expect(entry.configHashBefore).not.toBe(beforeSnapshot.hash);
    expect(entry.configHashAfter).not.toBe(afterSnapshot.hash);
  });

  it("retains the saved sign-in after rejection and retries without another login", async () => {
    const setup = await fixture();
    setup.run.mockImplementationOnce(async () => {
      expect(setup.readProfile()?.[1]).toMatchObject(credential);
      throw new Error("401 invalid_api_key: fixture provider rejected the request");
    });

    const rejected = await setup.activate();
    expect(rejected).toMatchObject({ ok: false });

    expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
    expect(setup.readProfile()?.[1]).toMatchObject(credential);
    const detection = await setup.detect();
    const saved = detection.candidates.find((candidate) =>
      candidate.kind.startsWith("saved-auth:"),
    );
    expect(saved).toMatchObject({ modelRef, credentials: true });
    if (!saved) {
      throw new Error("Setup did not offer the saved sign-in for retry");
    }

    const retried = await setup.activate(saved.kind);
    expect(retried).toMatchObject({ ok: true, modelRef });

    expect(setup.login).toHaveBeenCalledOnce();
    expect(setup.run).toHaveBeenCalledTimes(2);
    expect(setup.readProfile()?.[1]).toMatchObject(credential);
  });

  it.each([
    { explicitProfile: true, restartRequired: false, activationConfirmed: undefined },
    { explicitProfile: false, restartRequired: false, activationConfirmed: undefined },
    { explicitProfile: true, restartRequired: true, activationConfirmed: undefined },
    { explicitProfile: true, restartRequired: false, activationConfirmed: true as const },
  ])(
    "keeps a working credential and rotation when a replacement is rejected (configured: $explicitProfile, restart: $restartRequired, confirmed: $activationConfirmed)",
    async ({ explicitProfile, restartRequired, activationConfirmed }) => {
      const setup = await fixture({ restartRequired });
      const originalProfileId = "openai:fixture";
      const originalCredential = { ...credential, key: "working-original-key" };
      const configured: OpenClawConfig = {
        ...setup.config,
        agents: {
          ...setup.config.agents,
          defaults: {
            ...setup.config.agents?.defaults,
            model: { primary: `${modelRef}@${originalProfileId}` },
          },
        },
        ...(explicitProfile
          ? {
              auth: {
                profiles: { [originalProfileId]: { provider: "openai", mode: "api_key" as const } },
              },
            }
          : {}),
      };
      await persistProviderAuthProfilesAfterLogin({
        config: configured,
        agentDir: setup.agentDir,
        profiles: [{ profileId: originalProfileId, credential: originalCredential }],
      });
      const before = `${JSON.stringify(configured)}\n`;
      await fs.writeFile(setup.configPath, before);
      clearConfigCache();
      setup.run.mockRejectedValueOnce(new Error("401 invalid_api_key: replacement rejected"));

      const result = await setup.activate();

      expect(result).toMatchObject({ ok: false });
      expect(await fs.readFile(setup.configPath, "utf8")).toBe(before);
      const store = loadAuthProfileStoreWithoutExternalProfiles(setup.agentDir);
      expect(resolveAuthProfileOrder({ cfg: configured, store, provider: "openai" })).toEqual([
        originalProfileId,
      ]);
      expect(store.profiles[originalProfileId]).toEqual(originalCredential);
      expect(setup.readProfile()?.[1]).toEqual(
        expect.objectContaining({
          ...credential,
          setup: expect.objectContaining({ replacement: true }),
        }),
      );
      const saved = setup.readProfile();
      if (!saved) {
        throw new Error("The rejected replacement was not saved");
      }
      const [savedId, savedCredential] = saved;
      expect(savedId).not.toBe(originalProfileId);
      expect(
        buildAuthHealthSummary({ store, cfg: configured }).profiles.find(
          (profile) => profile.profileId === savedId,
        ),
      ).toMatchObject({
        status: "missing",
        reasonCode: "setup_inactive",
        label: expect.stringContaining("inactive"),
      });
      expect(resolveAuthProfilePortability(savedCredential).portable).toBe(false);
      expect(
        await resolveApiKeyForProfile({
          cfg: configured,
          store,
          profileId: savedId,
          agentDir: setup.agentDir,
        }),
      ).toBeNull();
      const snapshot = await readConfigFileSnapshot();
      const route = await resolveSystemAgentConfiguredRouteFromConfig(
        snapshot.runtimeConfig ?? snapshot.config,
      );
      expect(route?.authProfileId).toBe(originalProfileId);
      if (!route) {
        throw new Error("The original configured route disappeared after replacement rejection");
      }
      const auth = await setup.resolveAuth({
        provider: route.provider,
        cfg: route.runConfig,
        agentDir: route.agentDir,
        profileId: route.authProfileId,
        lockedProfile: true,
        modelId: route.model,
        modelApi: "openai-responses",
        secretSentinels: false,
      });
      expect(auth.apiKey).toBe("working-original-key");
      expect(setup.run).toHaveBeenCalledOnce();

      const retryKind = `saved-auth:${encodeURIComponent(savedId)}` as const;
      const declined = await setup.activate(retryKind);
      expect(declined).toMatchObject({ ok: false });
      expect(setup.prompter.confirm).toHaveBeenCalledWith({
        message: "Connection verified. Activate this saved sign-in?",
        initialValue: true,
      });
      expect(await fs.readFile(setup.configPath, "utf8")).toBe(before);
      const inactive = loadAuthProfileStoreWithoutExternalProfiles(setup.agentDir);
      expect(inactive.order).toEqual(store.order);
      expect(inactive.lastGood).toEqual(store.lastGood);
      expect(inactive.usageStats).toEqual(store.usageStats);

      vi.mocked(setup.prompter.confirm).mockImplementation(
        async ({ initialValue }) => initialValue ?? false,
      );
      const accepted = await setup.activate(retryKind, activationConfirmed);
      expect(accepted).toMatchObject({ ok: true });
      expect(setup.readProfile()).toEqual([savedId, credential]);
      expect(setup.login).toHaveBeenCalledOnce();
      expect(setup.run).toHaveBeenCalledTimes(3);
      expect(
        loadAuthProfileStoreWithoutExternalProfiles(setup.agentDir).profiles[originalProfileId],
      ).toEqual(originalCredential);
    },
  );

  it("activates saved sparse model settings without treating runtime defaults as a changed connection", async () => {
    const setup = await fixture();
    const configured: OpenClawConfig = {
      ...setup.config,
      agents: {
        ...setup.config.agents,
        defaults: { ...setup.config.agents?.defaults, model: `${modelRef}@openai:original` },
      },
    };
    await persistProviderAuthProfilesAfterLogin({
      config: configured,
      agentDir: setup.agentDir,
      profiles: [
        { profileId: "openai:original", credential: { ...credential, key: "original-key" } },
      ],
    });
    await fs.writeFile(setup.configPath, JSON.stringify(configured));
    clearConfigCache();
    const sparse = validateConfigObjectRaw({
      ...configured,
      models: {
        providers: {
          openai: {
            baseUrl: "https://provider.example/v1",
            api: "openai-responses",
            models: [{ id: "gpt-5.4-mini", name: "Sparse saved model" }],
          },
        },
      },
    });
    assert.ok(sparse.ok);
    const saved = await saveSetupCredential({
      profile: { profileId: "openai:replacement", credential },
      config: sparse.config,
      baseConfig: configured,
      agentDir: setup.agentDir,
      modelRef,
      authChoice: "fixture-login",
      pluginId: "openai",
    });

    const result = await setup.activate(
      `saved-auth:${encodeURIComponent(saved.profile.profileId)}`,
      true,
    );

    expect(result).toMatchObject({ ok: true });
    expect(setup.readProfile()).toEqual([saved.profile.profileId, credential]);
    const snapshot = await readConfigFileSnapshot();
    expect(snapshot.sourceConfig.models?.providers?.openai?.models).toEqual([
      { id: "gpt-5.4-mini", name: "Sparse saved model" },
    ]);
  });

  it("preserves an unrelated config edit when selecting the verified model", async () => {
    const setup = await fixture();
    const changed = `${JSON.stringify({ ...setup.config, messages: { ackReaction: "seen" } })}\n`;
    setup.run.mockImplementation(async (params) => {
      await fs.writeFile(setup.configPath, changed);
      clearConfigCache();
      return setup.reply(params);
    });

    const result = await setup.activate();
    expect(result).toMatchObject({ ok: true, modelRef });

    const persisted = await readConfigFileSnapshot();
    expect(persisted.sourceConfig.messages?.ackReaction).toBe("seen");
    expect(resolveAgentModelPrimaryValue(persisted.sourceConfig.agents?.defaults?.model)).toBe(
      `${modelRef}@${setup.readProfile()?.[0]}`,
    );
    expect(setup.readProfile()?.[1]).toMatchObject(credential);
    expect(setup.run).toHaveBeenCalledOnce();
  });

  it("discovers a persisted API-key sign-in without an in-memory candidate or another login", async () => {
    const setup = await fixture({ authMethod: "api_key" });
    await persistProviderAuthProfilesAfterLogin({
      config: setup.config,
      agentDir: setup.agentDir,
      profiles: [{ profileId: "openai:fixture", credential }],
    });

    const detection = await setup.detect();
    const saved = detection.candidates.find((candidate) =>
      candidate.kind.startsWith("saved-auth:"),
    );
    expect(saved).toMatchObject({ modelRef, credentials: true });
    expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
    if (!saved) {
      throw new Error("Setup did not discover the persisted sign-in");
    }
    const result = await setup.activate(saved.kind);

    expect(result).toMatchObject({ ok: true, modelRef });
    expect(setup.login).not.toHaveBeenCalled();
    expect(setup.run).toHaveBeenCalledOnce();
    expect(setup.readProfile()?.[1]).toMatchObject(credential);
  });

  it("activates a saved account for an agent whose selected account was removed, preserving its model", async () => {
    const setup = await fixture({ authMethod: "api_key", primaryModel: "stable/global-model" });
    const configured: OpenClawConfig = {
      ...setup.config,
      agents: {
        ...setup.config.agents,
        entries: {
          main: { default: true, model: `${modelRef}@openai:removed` },
          other: { model: `${modelRef}@openai:other` },
        },
      },
    };
    await fs.writeFile(setup.configPath, JSON.stringify(configured));
    clearConfigCache();
    await persistProviderAuthProfilesAfterLogin({
      config: configured,
      agentDir: setup.agentDir,
      profiles: [{ profileId: "openai:replacement", credential }],
    });
    const method = setup.deps.resolvePluginProviders?.({ config: configured })[0]?.auth[0];
    assert.ok(method);
    method.starterModel = "openai/provider-default";

    const result = await setup.activate("saved-auth:openai%3Areplacement", true, {
      agentId: "main",
      modelRef,
    });

    expect(result).toMatchObject({ ok: true, modelRef });
    expect(setup.login).not.toHaveBeenCalled();
    expect(setup.run).toHaveBeenCalledOnce();
    expect(setup.run.mock.calls[0]?.[0]).toMatchObject({
      authProfileId: "openai:replacement",
      model: "gpt-5.4-mini",
      allowAuthProfileFallback: false,
    });
    expect(setup.readProfile()).toEqual(["openai:replacement", credential]);
    const saved = (await readConfigFileSnapshot()).sourceConfig;
    expect(saved.agents?.entries?.main?.model).toBe(`${modelRef}@openai:replacement`);
    expect(saved.agents?.defaults?.model).toEqual(configured.agents?.defaults?.model);
    expect(saved.agents?.entries?.other).toEqual(configured.agents?.entries?.other);
  });

  it("rejects a concurrent provider change without overwriting it or removing the sign-in", async () => {
    const setup = await fixture();
    const edited = structuredClone(setup.config);
    edited.models!.providers!.openai!.baseUrl = "https://changed.example/v1";
    const changed = `${JSON.stringify(edited)}\n`;
    setup.run.mockImplementation(async (params) => {
      await fs.writeFile(setup.configPath, changed);
      clearConfigCache();
      return setup.reply(params);
    });

    const result = await setup.activate();
    expect(result).toMatchObject({ ok: false });

    expect(await fs.readFile(setup.configPath, "utf8")).toBe(changed);
    expect(setup.readProfile()?.[1]).toMatchObject(credential);
    expect(setup.run).toHaveBeenCalledOnce();
  });
});

describe.each(["initial", "deferred"] as const)("setup %s error boundary", (phase) => {
  it.each([
    { name: "unknown", create: () => new Error(), status: null, abort: false },
    {
      name: "wizard cancellation",
      create: () => new WizardCancelledError(),
      status: null,
      abort: true,
    },
    {
      name: "wizard navigation",
      create: () => new WizardNavigationError("back"),
      status: null,
      abort: true,
    },
    {
      name: "setup cancellation",
      create: () => new SetupInferenceCancelledError(),
      status: "unavailable",
      abort: false,
    },
    {
      name: "unavailable",
      create: () => new SetupInferenceActivationUnavailableError(),
      status: "unavailable",
      abort: false,
    },
    {
      name: "owner drift",
      create: () => new SetupInferenceOwnerDriftError(),
      status: "auth",
      abort: false,
    },
    {
      name: "indeterminate",
      create: () => new SetupInferenceActivationIndeterminateError(),
      status: null,
      abort: false,
    },
    { name: "aborted signal", create: () => new Error(), status: "unavailable", abort: true },
  ])("preserves $name without exposing submitted secrets", async ({ create, status, abort }) => {
    const setup = await fixture({ authMethod: "api_key" });
    const controller = new AbortController();
    const submitted = "opaque-submitted-setup-secret";
    const payload = `activation failed: ${submitted}; {"access_token":"structured-setup-secret"}`;
    const fault = Object.assign(create(), {
      message: payload,
      cause: new Error(payload),
      stack: payload,
    });
    const fail = async (): Promise<never> => {
      if (abort) {
        controller.abort();
      }
      throw fault;
    };
    let complete: (() => Promise<boolean>) | undefined;
    const transition = vi
      .spyOn(activationTransition, "commitSetupInferenceActivation")
      .mockImplementation(async (params) => {
        if (phase === "initial") {
          return await fail();
        }
        assert(params.deferCompletion);
        params.deferCompletion(fail);
        return params.config;
      });
    const activation = setup.activate("api-key", true, {
      apiKey: submitted,
      signal: controller.signal,
      ...(phase === "deferred"
        ? {
            onActivationCompletion: (completion: () => Promise<boolean>) => {
              complete = completion;
            },
          }
        : {}),
    });
    let operation: Promise<unknown> = activation;
    if (phase === "deferred") {
      expect(await activation).toMatchObject({ ok: true });
      assert(complete);
      operation = complete();
    }
    if (phase === "initial" && status) {
      const result = await operation;
      expect(result).toMatchObject({ ok: false, status });
      expect(JSON.stringify(result)).not.toContain(submitted);
      expect(JSON.stringify(result)).not.toContain("structured-setup-secret");
    } else {
      const safe = await operation.catch((error: unknown) => error);
      expect(safe, JSON.stringify(safe)).toBeInstanceOf(fault.constructor);
      assert(safe instanceof Error);
      expect(safe).not.toBe(fault);
      expect(safe.cause).toBeUndefined();
      expect(`${safe.message}\n${safe.stack}`).not.toContain(submitted);
      expect(`${safe.message}\n${safe.stack}`).not.toContain("structured-setup-secret");
      if (fault instanceof WizardNavigationError) {
        expect(safe).toMatchObject({ direction: "back" });
      }
    }
    expect(transition).toHaveBeenCalledOnce();
  });
});
