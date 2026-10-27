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
import { loadAuthProfileStoreWithoutExternalProfiles as readAuthStore } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { upsertAuthProfileWithLock } from "../agents/auth-profiles/upsert-with-lock.js";
import * as cliCredentials from "../agents/cli-credentials.js";
import { fingerprintResolvedProviderAuth } from "../agents/execution-auth-binding.js";
import * as modelAuth from "../agents/model-auth.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import { buildAllowedModelSet } from "../agents/model-selection.js";
import { resolveConfiguredPrimaryModelForAgent } from "../agents/utility-model.js";
import { migrateLegacyConfig } from "../commands/doctor/shared/legacy-config-migrate.js";
import { ensureOnboardingAgent } from "../commands/onboard-agent.js";
import { hasResolvedRosterBeforeMigrations } from "../config/agent-roster-provenance.js";
import { clearConfigCache, readConfigFileSnapshot as readSnapshot } from "../config/config.js";
import { resolveAgentModelPrimaryValue as primaryModel } from "../config/model-input.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import { buildCatalogModel } from "../plugin-sdk/provider-catalog.test-support.js";
import {
  computeDeclaredSurfaceHash,
  mergePluginDeclaredSurfaces,
} from "../plugins/capability-summary.js";
import { persistProviderAuthProfilesAfterLogin } from "../plugins/provider-auth-persistence.js";
import { WizardCancelledError, WizardNavigationError } from "../wizard/prompts.js";
import { listSystemAgentAuditEntriesForTests } from "./audit.test-support.js";
import { resolveSystemAgentConfiguredRouteFromConfig as resolveConfiguredRoute } from "./inference-route.js";
import { credential, fixture, modelRef } from "./setup-inference-activate.test-support.js";
import {
  SetupInferenceActivationIndeterminateError,
  SetupInferenceActivationUnavailableError,
} from "./setup-inference-core.js";
import * as credentialActivation from "./setup-inference-credential-access.js";
import { saveSetupCredential } from "./setup-inference-credentials.js";
import { resetSetupInferenceState } from "./setup-inference-state.test-support.js";
import * as activationTransition from "./setup-inference-transition.js";
import { codexRuntimeArtifactAuth, pluginRecord } from "./verified-inference.test-support.js";

type Setup = Awaited<ReturnType<typeof fixture>>;
function expectCalls(setup: Setup, logins: number, probes: number) {
  expect(setup.login).toHaveBeenCalledTimes(logins);
  expect(setup.run).toHaveBeenCalledTimes(probes);
}
function saveProfile(
  setup: Setup,
  profileId: string,
  config = setup.config,
  value: AuthProfileCredential = credential,
) {
  return persistProviderAuthProfilesAfterLogin({
    config,
    agentDir: setup.agentDir,
    profiles: [{ profileId, credential: value }],
  });
}
async function writeConfig(setup: Setup, value: Setup["config"] | string) {
  await fs.writeFile(setup.configPath, typeof value === "string" ? value : JSON.stringify(value));
  clearConfigCache();
}

afterEach(resetSetupInferenceState);

describe("setup activation credentials and configuration", () => {
  it("restores a first config write when its activation is not applied", async () => {
    // The write pipeline stamps metadata the in-memory candidate lacks.
    const setup = await fixture({ authMethod: "api_key" });
    delete setup.config.meta;
    await writeConfig(setup, setup.config);
    let complete: (() => Promise<boolean>) | undefined;
    const result = await setup.activate("api-key", true, {
      apiKey: "synthetic-recovery-key",
      onActivationCompletion: (completion) => {
        complete = completion;
      },
    });
    expect(result).toMatchObject({ ok: true });
    assert(complete);
    // No reloader runs here, so the restore is written but never applied.
    await expect(complete()).rejects.toThrow("The previous connection was restored on disk");
    const { meta: _meta, ...restored } = JSON.parse(await fs.readFile(setup.configPath, "utf8"));
    expect(restored).toEqual(setup.config);
  });

  it.each([
    { target: "utility" as const, requested: undefined },
    { target: undefined, requested: "utility" as const },
  ])(
    "rejects setup-role mismatch before login ($target/$requested)",
    async ({ target, requested }) => {
      const setup = await fixture({ modelTarget: target });
      const result = await setup.activate("provider-auth", undefined, { modelTarget: requested });
      expect(result).toMatchObject({ ok: false, status: "unavailable" });
      expectCalls(setup, 0, 0);
      expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
    },
  );

  it("isolates utility activation from the primary model", async () => {
    const setup = await fixture({ modelTarget: "utility", primaryModel: "stable/working-model" });
    const result = await setup.activate();
    expect(result).toMatchObject({ ok: true, modelTarget: "utility", modelRef });
    const saved = await readSnapshot();
    expect(saved.sourceConfig.agents?.defaults?.model).toEqual(
      setup.config.agents?.defaults?.model,
    );
    expect(saved.sourceConfig.agents?.defaults?.utilityModel).toContain(modelRef);
    expect(setup.run.mock.calls[0]?.[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
  });

  it("signs in before verifying isolated Codex", async () => {
    const setup = await fixture({ codex: true, fresh: false, subscription: true });
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
    const saved = await readSnapshot();
    expect(saved.config.plugins?.entries?.codex?.config?.appServer).not.toHaveProperty(
      "homeScope",
      "user",
    );
    expect(setup.readProfile()?.[1].setup).toBeUndefined();
  });
  it.each([false, true])(
    "reuses native Codex credentials without import (automatic: %s)",
    async (automatic) => {
      const setup = await fixture({
        codex: true,
        homeScope: automatic ? "agent" : "user",
        nativeCatalogEnabled: true,
      });
      vi.spyOn(cliCredentials, "readCodexCliCredentialsCached").mockImplementation(() => {
        throw new Error("Setup must not read native Codex OAuth tokens");
      });
      const nativeAuth = {
        apiKey: "fixture-native-key",
        source: "Codex native login",
        mode: "api-key" as const,
      };
      vi.spyOn(modelAuth, "resolveApiKeyForProviderCore").mockResolvedValue(nativeAuth);
      const readNativeKey = vi.fn(() => credential);
      setup.readCodexCliActiveApiKey.mockImplementation(readNativeKey);
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
      const result = await setup.activate("codex-cli", automatic ? true : undefined, {
        automaticSetup: automatic ? true : undefined,
      });
      expect(result).toMatchObject({ ok: true });
      expectCalls(setup, 0, 1);
      expect(readNativeKey).not.toHaveBeenCalled();
      expect(setup.readProfile()).toBeUndefined();
      expect(
        (await readSnapshot()).config.plugins?.entries?.codex?.config?.appServer,
      ).toMatchObject({ homeScope: "user" });
      expect((await readSnapshot()).config.plugins?.entries?.codex?.config?.sessionCatalog).toEqual(
        { enabled: true },
      );
    },
  );

  it("does not activate a native sign-in revoked before commit", async () => {
    const setup = await fixture({ codex: true, homeScope: "user" });
    const verifySetup = vi.fn(async () => {
      if (verifySetup.mock.calls.length > 1) {
        throw new Error("Native account no longer has model access");
      }
    });
    setup.pluginRegistry.agentHarnesses[0] = {
      pluginId: "codex",
      source: "test",
      harness: {
        id: "codex",
        label: "Native setup fixture",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        verifySetup,
        runAttempt: async () => {
          throw new Error("Setup must not start a turn");
        },
      },
    };
    expect((await setup.activate("codex-cli")).ok).toBe(false);
    expect(verifySetup).toHaveBeenCalledTimes(2);
    expect(setup.run).not.toHaveBeenCalled();
    expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
  });

  it.each([
    { authMethod: "oauth", homeScope: "user" },
    { authMethod: "api_key", homeScope: "user" },
    { authMethod: "oauth", homeScope: "agent" },
  ] as const)(
    "isolates $authMethod sign-in from Codex $homeScope home",
    async ({ authMethod, homeScope }) => {
      const setup = await fixture({
        codex: true,
        homeScope,
        authMethod,
        subscription: authMethod === "oauth",
        primaryModel: modelRef,
      });
      // Provider login can select a new model without an authored runtime override.
      setup.config.agents!.defaults!.models![modelRef] = {};
      vi.mocked(setup.prompter.confirm).mockResolvedValue(true);
      await writeConfig(setup, setup.config);
      const result = await setup.activate(
        authMethod === "oauth" ? "provider-auth" : "api-key",
        undefined,
        authMethod === "api_key" ? { apiKey: credential.key } : {},
      );
      expect(result).toMatchObject({ ok: true });
      expect(setup.login).toHaveBeenCalledOnce();
      expect(setup.run.mock.calls[0]?.[0]).toMatchObject({
        agentHarnessRuntimeOverride: "codex",
        config: {
          plugins: { entries: { codex: { config: { appServer: { homeScope: "agent" } } } } },
        },
      });
      expect(
        (await readSnapshot()).config.plugins?.entries?.codex?.config?.appServer,
      ).toMatchObject({ homeScope: "agent" });
      expect(setup.readProfile()?.[1].setup).toBeUndefined();
    },
  );

  it.each([true, false])(
    "requires official Codex only for automatic setup (%s)",
    async (automatic) => {
      const setup = await fixture({ codex: true });
      const resolveMetadata = setup.resolvePluginMetadataSnapshot.getMockImplementation();
      assert.ok(resolveMetadata);
      const acceptedSurface = mergePluginDeclaredSurfaces([]);
      setup.resolvePluginMetadataSnapshot.mockImplementation((params) => {
        const metadata = resolveMetadata(params);
        return {
          ...metadata,
          index: {
            ...metadata.index,
            plugins: [
              ...metadata.index.plugins.filter((plugin) => plugin.pluginId !== "codex"),
              pluginRecord("codex", { packageName: "@example/codex" }),
            ],
            installRecords: {
              ...metadata.index.installRecords,
              codex: {
                source: "npm",
                spec: "@example/codex@1.0.0",
                acceptedSurface,
                acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
                acceptedSurfaceAt: "2026-01-01T00:00:00.000Z",
              },
            },
          },
        };
      });

      const result = await setup.activate("codex-cli", automatic ? true : undefined, {
        automaticSetup: automatic ? true : undefined,
      });
      expect(result).toMatchObject({ ok: !automatic });
      if (automatic) {
        expect(result).toMatchObject({ error: expect.stringContaining("official Codex plugin") });
        expectCalls(setup, 0, 0);
        expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
      } else {
        expectCalls(setup, 1, 1);
      }
    },
  );

  it.each(["cancelled", "missing-credentials"] as const)(
    "does not promote %s Codex sign-in",
    async (failure) => {
      const cancelled = failure === "cancelled";
      const controller = new AbortController();
      const setup = await fixture({
        codex: true,
        ...(cancelled ? { signal: controller.signal } : {}),
      });
      if (cancelled) {
        setup.login.mockImplementationOnce(async () => {
          controller.abort();
          throw new WizardCancelledError();
        });
      } else {
        vi.spyOn(cliCredentials, "readCodexCliCredentialsCached").mockImplementation(() => {
          throw new Error("Setup must not read native Codex OAuth tokens");
        });
        setup.run.mockRejectedValueOnce(new Error("Codex needs ChatGPT sign-in"));
      }
      const result = await setup.activate(
        "codex-cli",
        cancelled ? undefined : true,
        cancelled ? {} : { automaticSetup: true },
      );
      expect(result).toMatchObject(
        cancelled
          ? { ok: false }
          : {
              ok: false,
              error: expect.stringContaining("ChatGPT sign-in"),
            },
      );
      expectCalls(setup, cancelled ? 1 : 0, cancelled ? 0 : 1);
      expect(setup.readProfile()).toBeUndefined();
      expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
    },
  );

  it.each(["saved", "native-key"] as const)(
    "reuses %s Codex credentials without login",
    async (source) => {
      const setup = await fixture({ codex: true });
      if (source === "saved") {
        await saveProfile(setup, "openai:existing");
      } else {
        setup.readCodexCliActiveApiKey.mockReturnValue(credential);
      }
      const result = await setup.activate("codex-cli");
      expect(result, result.ok ? undefined : result.error).toMatchObject({ ok: true });
      expectCalls(setup, 0, 1);
      expect(setup.readProfile()?.[1]).toMatchObject(credential);
      if (source === "saved") {
        expect(setup.run.mock.calls[0]?.[0].authProfileId).toBe("openai:existing");
      }
    },
  );

  it.each(["abort", "replacement"] as const)(
    "keeps SecretRef inactive after final %s revocation",
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
              expect(readAuthStore(setup.agentDir).profiles[profileId]?.setup).toBeDefined();
              if (revocation === "abort") {
                controller.abort();
              } else {
                const replace = (replacement: AuthProfileCredential) =>
                  upsertAuthProfileWithLock({
                    agentDir: setup.agentDir,
                    profileId,
                    credential: replacement,
                  });
                expect(
                  await replace({
                    ...source,
                    type: "api_key",
                    keyRef: {
                      source: "env",
                      provider: "default",
                      id: "UNREAD_REPLACEMENT_FIXTURE",
                    },
                  }),
                ).not.toBeNull();
                expect(await replace(source)).not.toBeNull();
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
    for (const provider of ["openai", "other"]) {
      await upsertAuthProfileWithLock({
        profileId: `${provider}:saved`,
        credential: { ...savedCredential, provider },
        agentDir: setup.agentDir,
      });
    }

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
    expect(readAuthStore(setup.agentDir).profiles["openai:saved"]).toEqual(savedCredential);
  });

  it("preserves first-team provisioning across provider activation", async () => {
    const setup = await fixture({ fresh: true });
    const result = await setup.activate();
    expect(result).toMatchObject({ ok: true });
    const activated = await readSnapshot();
    expect(hasResolvedRosterBeforeMigrations(activated)).toBe(false);
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
      const policy = resolveModelRuntimePolicy({
        config: created.config,
        agentId,
        provider: "openai",
        modelId,
      });
      expect(policy.policy?.id).toBe("openclaw");
      const auth = await setup.resolveAuth({
        provider: "openai",
        cfg: created.config,
        agentDir: resolveAgentDir(created.config, agentId),
        workspaceDir: path.join(setup.workspace, agentId),
        profileId: setup.readProfile()?.[0],
        lockedProfile: true,
        modelId,
        modelApi: "openai-responses",
      });
      expect(auth.profileId).toBe(setup.readProfile()?.[0]);
    }
    const allowed = buildAllowedModelSet({
      cfg: created.config,
      catalog: [],
      defaultProvider: "openai",
    });
    expect(allowed.allowAny).toBe(true);
    expect(created.config.agents?.defaults?.model).toBe(`${modelRef}@${setup.readProfile()?.[0]}`);
  });

  it("saves credentials before the probe and commits after success", async () => {
    const setup = await fixture({ localService: true, addProviderDuringLogin: false });
    setup.run.mockImplementation(async (params) => {
      expect(setup.readProfile()?.[1]).toMatchObject(credential);
      expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
      expect(params.disableTools).toBe(true);
      expect(primaryModel(params.config?.agents?.defaults?.model)).toContain(modelRef);
      return setup.reply(params);
    });

    const result = await setup.activate();
    expect(result).toMatchObject({ ok: true, modelRef });
    expect(setup.readProfile()?.[1]).not.toHaveProperty("setup");

    expectCalls(setup, 1, 1);
    const persisted = await readSnapshot();
    expect(persisted.valid).toBe(true);
    expect(primaryModel(persisted.sourceConfig.agents?.defaults?.model)).toBe(
      `${modelRef}@${setup.readProfile()?.[0]}`,
    );
  });

  it("audits root hashes without changing config includes", async () => {
    const setup = await fixture({ surface: "gateway" });
    const includePath = path.join(path.dirname(setup.configPath), "logging.json5");
    const included = '{level:"warn"}\n';
    const before = `${JSON.stringify({ ...setup.config, logging: { $include: "./logging.json5" } })}\n`;
    await fs.writeFile(includePath, included);
    await writeConfig(setup, before);
    const beforeSnapshot = await readSnapshot();

    const result = await setup.activate();

    expect(result).toMatchObject({ ok: true, modelRef });
    const after = await fs.readFile(setup.configPath, "utf8");
    const afterSnapshot = await readSnapshot();
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

  it.each([false, true])(
    "retries saved sign-in without another login (Codex: %s)",
    async (codex) => {
      const setup = await fixture({ codex });
      setup.run.mockImplementationOnce(async () => {
        if (!codex) {
          expect(setup.readProfile()?.[1]).toMatchObject(credential);
        }
        throw new Error(
          codex
            ? "fixture provider unavailable"
            : "401 invalid_api_key: fixture provider rejected the request",
        );
      });
      expect(await setup.activate(codex ? "codex-cli" : "provider-auth")).toMatchObject({
        ok: false,
      });
      expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
      let kind: Parameters<typeof setup.activate>[0];
      if (codex) {
        const saved = setup.readProfile();
        assert.ok(saved);
        expect(saved[1].setup?.agentRuntimeId).toBe("codex");
        expect(JSON.parse(saved[1].setup!.configJson).plugins.entries.codex.enabled).toBe(true);
        kind = `saved-auth:${encodeURIComponent(saved[0])}`;
      } else {
        expect(setup.readProfile()?.[1]).toMatchObject(credential);
        const saved = (await setup.detect()).candidates.find((candidate) =>
          candidate.kind.startsWith("saved-auth:"),
        );
        expect(saved).toMatchObject({ modelRef, credentials: true });
        assert.ok(saved, "Setup did not offer the saved sign-in for retry");
        kind = saved.kind;
      }
      expect(await setup.activate(kind, codex ? true : undefined)).toMatchObject({
        ok: true,
        modelRef,
      });
      expectCalls(setup, 1, 2);
      if (codex) {
        expect(setup.run.mock.calls[1]?.[0].agentHarnessRuntimeOverride).toBe("codex");
      } else {
        expect(setup.readProfile()?.[1]).toMatchObject(credential);
      }
    },
  );

  it("keeps working credentials and rotation after rejected replacement", async () => {
    const setup = await fixture();
    const originalProfileId = "openai:fixture";
    const originalCredential = { ...credential, key: "working-original-key" };
    const configured = structuredClone(setup.config);
    assert(configured.agents?.defaults);
    configured.agents.defaults.model = { primary: `${modelRef}@${originalProfileId}` };
    configured.auth = {
      profiles: { [originalProfileId]: { provider: "openai", mode: "api_key" } },
    };
    await saveProfile(setup, originalProfileId, configured, originalCredential);
    const before = `${JSON.stringify(configured)}\n`;
    await writeConfig(setup, before);
    setup.run.mockRejectedValueOnce(new Error("401 invalid_api_key: replacement rejected"));

    const result = await setup.activate();

    expect(result).toMatchObject({ ok: false });
    expect(await fs.readFile(setup.configPath, "utf8")).toBe(before);
    const store = readAuthStore(setup.agentDir);
    expect(resolveAuthProfileOrder({ cfg: configured, store, provider: "openai" })).toEqual([
      originalProfileId,
    ]);
    expect(store.profiles[originalProfileId]).toEqual(originalCredential);
    expect(setup.readProfile()?.[1]).toMatchObject({ ...credential, setup: { replacement: true } });
    const saved = setup.readProfile();
    assert.ok(saved, "The rejected replacement was not saved");
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
    const snapshot = await readSnapshot();
    const route = await resolveConfiguredRoute(snapshot.runtimeConfig ?? snapshot.config);
    expect(route?.authProfileId).toBe(originalProfileId);
    assert.ok(route, "The original configured route disappeared after replacement rejection");
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
    const inactive = readAuthStore(setup.agentDir);
    expect(inactive.order).toEqual(store.order);
    expect(inactive.lastGood).toEqual(store.lastGood);
    expect(inactive.usageStats).toEqual(store.usageStats);

    vi.mocked(setup.prompter.confirm).mockImplementation(
      async ({ initialValue }) => initialValue ?? false,
    );
    const accepted = await setup.activate(retryKind);
    expect(accepted).toMatchObject({ ok: true });
    expect(setup.readProfile()).toEqual([savedId, credential]);
    expectCalls(setup, 1, 3);
    expect(readAuthStore(setup.agentDir).profiles[originalProfileId]).toEqual(originalCredential);
  });

  it("discovers persisted API keys without cached candidates or login", async () => {
    const setup = await fixture({ authMethod: "api_key" });
    await saveProfile(setup, "openai:fixture");

    const detection = await setup.detect();
    const saved = detection.candidates.find((candidate) =>
      candidate.kind.startsWith("saved-auth:"),
    );
    expect(saved).toMatchObject({ modelRef, credentials: true });
    expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
    assert.ok(saved, "Setup did not discover the persisted sign-in");
    const result = await setup.activate(saved.kind);

    expect(result).toMatchObject({ ok: true, modelRef });
    expectCalls(setup, 0, 1);
    expect(setup.readProfile()?.[1]).toMatchObject(credential);
  });

  it("replaces a removed account without changing agent models", async () => {
    const setup = await fixture({ authMethod: "api_key", primaryModel: "stable/global-model" });
    const configured = structuredClone(setup.config);
    assert(configured.agents?.defaults);
    configured.agents.ownership = "explicit";
    configured.agents.defaults.systemAgent = { agentId: "main" };
    configured.agents.entries = {
      main: { model: `${modelRef}@openai:removed` },
      other: { model: `${modelRef}@openai:other` },
    };
    await writeConfig(setup, configured);
    await saveProfile(setup, "openai:replacement", configured);
    const method = setup.provider.auth[0];
    assert.ok(method);
    method.starterModel = "openai/provider-default";

    const result = await setup.activate("saved-auth:openai%3Areplacement", true, {
      agentId: "main",
      modelRef,
    });

    expect(result).toMatchObject({ ok: true, modelRef });
    expectCalls(setup, 0, 1);
    expect(setup.run.mock.calls[0]?.[0]).toMatchObject({
      authProfileId: "openai:replacement",
      model: "gpt-5.4-mini",
      allowAuthProfileFallback: false,
    });
    expect(setup.readProfile()).toEqual(["openai:replacement", credential]);
    const saved = (await readSnapshot()).sourceConfig;
    expect(saved.agents?.entries?.main?.model).toBe(`${modelRef}@openai:replacement`);
    expect(saved.agents?.defaults?.model).toEqual(configured.agents?.defaults?.model);
    expect(saved.agents?.entries?.other).toEqual(configured.agents?.entries?.other);
  });

  it.each([false, true])(
    "preserves concurrent config edits (provider changed: %s)",
    async (providerChanged) => {
      const setup = await fixture();
      const edited = structuredClone(setup.config);
      if (providerChanged) {
        edited.models!.providers!.openai!.baseUrl = "https://changed.example/v1";
      } else {
        edited.messages = { ackReaction: "seen" };
      }
      const changed = `${JSON.stringify(edited)}\n`;
      setup.run.mockImplementation(async (params) => {
        await writeConfig(setup, changed);
        return setup.reply(params);
      });

      const result = await setup.activate();
      expect(result).toMatchObject(providerChanged ? { ok: false } : { ok: true, modelRef });
      if (providerChanged) {
        expect(await fs.readFile(setup.configPath, "utf8")).toBe(changed);
      } else {
        const persisted = (await readSnapshot()).sourceConfig;
        expect(persisted.messages?.ackReaction).toBe("seen");
        expect(primaryModel(persisted.agents?.defaults?.model)).toBe(
          `${modelRef}@${setup.readProfile()?.[0]}`,
        );
      }
      expect(setup.readProfile()?.[1]).toMatchObject(credential);
      expect(setup.run).toHaveBeenCalledOnce();
    },
  );
});

describe("setup activation error boundaries", () => {
  // Both entry points share redaction; the initial path also maps typed failures to results.
  it.each([
    ["initial", "wizard navigation", () => new WizardNavigationError("back"), null, true],
    [
      "initial",
      "unavailable",
      () => new SetupInferenceActivationUnavailableError(),
      "unavailable",
      false,
    ],
    [
      "initial",
      "indeterminate",
      () => new SetupInferenceActivationIndeterminateError(),
      null,
      false,
    ],
    ["deferred", "unknown", () => new Error(), null, false],
  ] as const)(
    "%s boundary preserves %s without exposing submitted secrets",
    async (phase, _name, create, status, abort) => {
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
        onActivationCompletion:
          phase === "deferred"
            ? (completion) => {
                complete = completion;
              }
            : undefined,
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
    },
  );
});

describe("setup utility activation", () => {
  const utilityResult = { ok: true, modelRef, modelTarget: "utility" };
  const utilityDetection = { utilityModel: modelRef, setupModel: modelRef, setupComplete: false };
  async function writeUtilityConfig(configPath: string, config: unknown) {
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    clearConfigCache();
  }
  it.each([modelRef, "legacy/working", undefined])(
    "preserves implicit primary %s across utility login",
    async (priorModel) => {
      const setup = await fixture({
        modelTarget: "utility",
        addProviderDuringLogin: priorModel !== modelRef,
        fresh: priorModel === undefined,
      });
      delete setup.config.meta;
      const defaults = setup.config.agents?.defaults;
      assert(defaults);
      if (priorModel) {
        defaults.utilityModel = priorModel;
      }
      if (priorModel === "legacy/working") {
        setup.config.models = {
          providers: {
            legacy: {
              api: "openai-completions",
              baseUrl: "https://legacy.example/v1",
              models: [buildCatalogModel("working", { name: "Legacy fixture", maxTokens: 4096 })],
            },
          },
        };
      }
      await writeUtilityConfig(setup.configPath, setup.config);

      if (priorModel) {
        const before = await fs.readFile(setup.configPath, "utf8");
        await expect(setup.activate()).rejects.toThrow(/doctor --fix|explicit primary/i);
        expect([setup.login.mock.calls, setup.run.mock.calls]).toEqual([[], []]);
        expect(await fs.readFile(setup.configPath, "utf8")).toBe(before);
        const migrated = migrateLegacyConfig(setup.config, {
          sourceConfigBeforeMigrations: setup.config,
        });
        assert(migrated.config);
        expect(migrated.partiallyValid).toBeUndefined();
        await writeUtilityConfig(setup.configPath, migrated.config);
      }

      vi.mocked(setup.prompter.confirm).mockResolvedValue(true);
      const result = await setup.activate();

      expect(result, result.ok ? undefined : result.error).toMatchObject(utilityResult);
      expect(setup.login).toHaveBeenCalledOnce();
      expect(setup.run).toHaveBeenCalledOnce();
      const candidate = setup.run.mock.calls[0]?.[0].config;
      assert(candidate);
      expect(resolveConfiguredPrimaryModelForAgent({ cfg: candidate, agentId: "main" })).toBe(
        priorModel,
      );
      const { valid, sourceConfig: source } = await readSnapshot();
      const profile = setup.readProfile();
      assert(profile);
      expect(valid).toBe(true);
      expect(source.meta?.migrations?.utilityModelSeparation).toBe(true);
      expect(primaryModel(source.agents?.defaults?.model)).toBe(priorModel);
      expect(source.agents?.defaults?.utilityModel).toBe(`${modelRef}@${profile[0]}`);
      expect(source.models?.providers?.openai?.models[0]?.id).toBe("gpt-5.4-mini");
      if (priorModel === "legacy/working") {
        expect(source.models?.providers?.legacy).toEqual(setup.config.models?.providers?.legacy);
      }
      if (!priorModel) {
        const detected = await setup.detect();
        expect(detected).toMatchObject(utilityDetection);
        expect(detected.configuredModel).toBeUndefined();
      }
    },
  );

  it.each(["helper", modelRef])(
    "rechecks canonical identity while preserving authored %s and its profile",
    async (authoredModel) => {
      const setup = await fixture({ modelTarget: "utility" });
      expect(await setup.activate()).toMatchObject({ ok: true });
      const profile = setup.readProfile();
      assert(profile);
      const config = (await readSnapshot()).sourceConfig;
      const defaults = config.agents?.defaults;
      assert(defaults?.models?.[modelRef]);
      defaults.models[modelRef].alias = "helper";
      defaults.utilityModel = `${authoredModel}@${profile[0]}`;
      const authoredConfig = `${JSON.stringify(config, null, 2)}\n`;
      await fs.writeFile(setup.configPath, authoredConfig);
      clearConfigCache();

      const detected = await setup.detect();
      expect(detected).toMatchObject(utilityDetection);
      expect(detected.configuredModel).toBeUndefined();
      const candidate = detected.candidates.find(
        (entry) => entry.kind === "existing-model" && entry.modelTarget === "utility",
      );
      assert(candidate);
      expect(candidate.modelRef).toBe(modelRef);
      setup.run.mockClear();
      const verified = await setup.activate("existing-model", undefined, {
        modelRef: candidate.modelRef,
        modelTarget: candidate.modelTarget,
      });
      expect(verified).toMatchObject(utilityResult);
      expect(setup.run).toHaveBeenCalledOnce();
      expect(setup.run.mock.calls[0]?.[0].authProfileId).toBe(profile[0]);
      expect(await fs.readFile(setup.configPath, "utf8")).toBe(authoredConfig);
    },
  );
});

describe("saved provider replacement", () => {
  it.each([
    undefined,
    { auth: { mode: "header" as const, headerName: "X-New-Key", value: "replacement-key" } },
  ])("replaces saved provider settings without reviving old auth (%j)", async (request) => {
    const setup = await fixture();
    const configured = structuredClone(setup.config);
    assert(configured.agents?.defaults);
    configured.agents.defaults.model = `${modelRef}@openai:original`;
    assert(configured.models?.providers?.openai);
    const original = configured.models.providers.openai;
    original.request = {
      auth: { mode: "header", headerName: "X-Old-Key", value: "original-key" },
      headers: { "X-Old-Request-Key": "original-request-key" },
    };
    original.headers = {
      "X-Old-Provider-Key": "original-provider-key",
    };
    const unrelatedProvider = {
      ...structuredClone(original),
      baseUrl: "https://unrelated.example/v1",
    };
    configured.models.providers.unrelated = unrelatedProvider;
    await saveProfile(setup, "openai:original", configured, { ...credential, key: "original-key" });
    await writeConfig(setup, configured);
    const unrelatedRuntimeProvider = structuredClone(
      (await readSnapshot()).config.models?.providers?.unrelated,
    );
    const replacement = {
      baseUrl: "https://replacement.example/v1",
      api: "openai-responses",
      models: [{ id: "gpt-5.4-mini", name: "Sparse saved model" }],
      ...(request ? { request } : {}),
    };
    const sparse = validateConfigObjectRaw({
      ...configured,
      models: { providers: { openai: replacement } },
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

    const profileId = saved.profile.profileId;
    const result = await setup.activate(`saved-auth:${encodeURIComponent(profileId)}`, true);

    expect(result).toMatchObject({ ok: true });
    expect(setup.readProfile()).toEqual([profileId, credential]);
    const snapshot = await readSnapshot();
    for (const [providers, unrelated] of [
      [setup.run.mock.calls[0]?.[0].config?.models?.providers, unrelatedRuntimeProvider],
      [snapshot.sourceConfig.models?.providers, unrelatedProvider],
    ] as const) {
      expect(providers?.openai).toMatchObject({
        baseUrl: replacement.baseUrl,
        apiKey: profileId,
      });
      expect(providers?.openai?.request).toEqual(request);
      expect(providers?.openai?.headers).toBeUndefined();
      expect(providers?.unrelated).toEqual(unrelated);
    }
    expect(snapshot.sourceConfig.models?.providers?.openai?.models).toEqual(replacement.models);
  });
});
