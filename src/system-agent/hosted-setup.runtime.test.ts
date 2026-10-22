import "./chat-engine.mocks.test-support.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyAccountNameToChannelSection } from "../channels/plugins/setup-helpers.js";
import type { SetupChannelsOptions } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { committedConfigFiles as hostedConfigFiles } from "../commands/committed-config.test-support.js";
import { withCommandPluginMetadata } from "../commands/config-validation.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getPluginCache,
  type PluginCache,
} from "../plugins/plugin-cache.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import {
  hasPluginLifecycleLease,
  withPluginLifecycleLease,
} from "../plugins/plugin-lifecycle-lease.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "../plugins/runtime/generation-scope.js";
import { createInstallAccountPolicyFixture } from "../plugins/test-helpers/install-account-policy.test-support.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveChannelAccountEntry } from "../routing/account-lookup.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import * as audit from "./audit.js";
import {
  fakeOverviewLoader,
  sharedVerifiedInferenceConfig,
  mocks,
  useTempStateDir,
  createAmbientVerifiedBinding,
  SystemAgentChatEngine,
  advanceGatewayWizardToSecretStorage,
  type OpenClawConfig,
  type WizardPrompter,
} from "./chat-engine.test-support.js";
import { ChatWizardHost } from "./chat-wizard-host.js";
import * as hostedSetup from "./hosted-setup.runtime.js";
import { createInferenceConfigFixture } from "./inference-config.test-support.js";

function createEngine(options: ConstructorParameters<typeof SystemAgentChatEngine>[0] = {}) {
  return new SystemAgentChatEngine({
    runAgentTurn: async () => null,
    ...options,
    deps: { loadOverview: fakeOverviewLoader(), ...options.deps },
  });
}

function useConfigWriter() {
  mocks.writeWizardConfigFile.mockImplementation(async (config: OpenClawConfig) =>
    hostedConfigFiles.write(config),
  );
}

function installAudit() {
  return vi.spyOn(audit, "appendSystemAgentAuditEntry").mockResolvedValue("state/openclaw.sqlite");
}

function setupSnapshot(config: OpenClawConfig, hash: string) {
  return { exists: true, valid: true, hash, config, sourceConfig: config };
}

function useSetupConfig(config: OpenClawConfig, hash: string) {
  mocks.readSetupConfigFileSnapshot.mockResolvedValue(setupSnapshot(config, hash));
}

function useGatewayConfig() {
  const config: OpenClawConfig = {
    ...structuredClone(sharedVerifiedInferenceConfig),
    gateway: { mode: "local" },
  };
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
  vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
  useSetupConfig(config, "gateway-base-hash");
  useConfigWriter();
  return config;
}

function channelConfig(): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    auth: { profiles: { "openai:main": { provider: "openai", mode: "api_key" } } },
    models: structuredClone(sharedVerifiedInferenceConfig.models),
  };
}

type ChannelArgs = [OpenClawConfig, unknown, WizardPrompter, SetupChannelsOptions];
type ChatSetupArgs = [OpenClawConfig, WizardPrompter, SetupChannelsOptions];

function useChannelSetup(setup: (...args: ChatSetupArgs) => Promise<OpenClawConfig>) {
  mocks.setupChannels.mockImplementation((...[config, , prompter, options]: ChannelArgs) =>
    setup(config, prompter, options),
  );
}

describe("SystemAgentChatEngine runtime", () => {
  it.each(["disposed", "completed"] as const)(
    "retires retained channel write authority after hosted setup is %s",
    async (ending) => {
      let retainedOptions: SetupChannelsOptions | undefined;
      const prepare = vi.fn(async () => {});
      useSetupConfig({}, "channel-lifetime-hash");
      useConfigWriter();
      useChannelSetup(async (config, prompter, options) => {
        retainedOptions = options;
        await options.beforePersistentEffect?.();
        await prompter.text({ message: "Waiting for channel login" });
        return config;
      });
      installAudit();
      const host = new ChatWizardHost({
        surface: "gateway",
        beforePersistentApply: prepare,
      });
      try {
        expect((await host.startChannel("zalouser")).text).toContain("Waiting for channel login");
        const assertCurrent = retainedOptions?.assertPersistentEffectCurrent;
        if (!assertCurrent) {
          throw new Error("Hosted channel setup did not retain its live owner assertion");
        }
        expect(assertCurrent).not.toThrow();
        if (ending === "disposed") {
          host.dispose();
        } else {
          expect((await host.resolveReply("continue")).configWritten).toBe(true);
        }
        expect(assertCurrent).toThrow();
        const preparationCount = prepare.mock.calls.length;
        await expect(retainedOptions?.beforePersistentEffect?.()).rejects.toThrow();
        expect(prepare).toHaveBeenCalledTimes(preparationCount);
      } finally {
        host.dispose();
      }
    },
  );

  it("hosts the real skills setup flow and guards installs plus the final config write", async () => {
    const baseConfig: OpenClawConfig = {
      agents: { defaults: { workspace: "/tmp/skills-workspace" } },
    };
    const beforeEffects: Array<() => Promise<void>> = [];
    const appendAuditEntry = installAudit();
    useSetupConfig(baseConfig, "skills-base-hash");
    mocks.setupSkills.mockImplementation(
      async (
        ...[config, workspaceDir, , prompter, options = {}]: Parameters<
          typeof import("../commands/onboard-skills.js").setupSkills
        >
      ) => {
        expect(workspaceDir).toBe("/tmp/skills-workspace");
        expect(options.beforePersistentEffect).toBeTypeOf("function");
        beforeEffects.push(options.beforePersistentEffect!);
        await prompter.note("Eligible: 2\nMissing requirements: 1", "Skills status");
        await options.beforePersistentEffect?.();
        return { ...config, skills: { install: { nodeManager: "npm" } } };
      },
    );
    useConfigWriter();
    const engine = createEngine({ surface: "gateway" });

    const reply = await engine.handle("configure skills");

    expect(reply.text).toContain("skills dependency setup is complete");
    expect(beforeEffects).toHaveLength(1);
    expect(mocks.writeWizardConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({ skills: { install: { nodeManager: "npm" } } }),
      { allowConfigSizeDrop: false, baseHash: "skills-base-hash" },
    );
    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "skills.setup" }),
    );
  });

  it("hosts search setup as question cards and keeps gateway credentials out of model history", async () => {
    const baseConfig: OpenClawConfig = {};
    const appendAuditEntry = installAudit();
    const beforePersistentEffects: Array<() => Promise<void>> = [];
    useSetupConfig(baseConfig, "search-base-hash");
    mocks.runSearchSetupFlow.mockImplementation(
      async (
        ...[config, , prompter, options = {}]: Parameters<
          typeof import("../flows/search-setup.js").runSearchSetupFlow
        >
      ) => {
        expect(options.preserveDisabledSearchState).toBe(false);
        beforePersistentEffects.push(options.beforePersistentEffect!);
        const provider = await prompter.select({
          message: "Search provider",
          options: [
            { value: "brave", label: "Brave" },
            { value: "grok", label: "Grok" },
          ],
          initialValue: "brave",
        });
        const key = await prompter.text({ message: "Provider API key", sensitive: true });
        expect(key).toBe("search-secret-value");
        await options.beforePersistentEffect?.();
        return {
          outcome: "completed",
          config: {
            ...config,
            tools: { web: { search: { enabled: true, provider } } },
          } as OpenClawConfig,
        };
      },
    );
    useConfigWriter();
    const engine = createEngine({ surface: "gateway" });

    const providerStep = await engine.handle("configure search");
    expect(providerStep.question).toEqual({
      id: expect.any(String),
      header: "Choose one",
      question: "Search provider",
      options: [{ label: "Brave", recommended: true }, { label: "Grok" }],
    });

    const secretStep = await engine.handle("Brave");
    expect(secretStep.text).toContain("Provider API key");
    expect(secretStep.sensitive).toBe(true);
    expect(secretStep.question).toBeUndefined();

    const done = await engine.handle("search-secret-value");
    expect(done.text).toContain("web search setup is complete");
    expect(beforePersistentEffects).toHaveLength(1);
    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "search.setup" }),
    );
    expect(JSON.stringify(engine.historySince(0))).not.toContain("search-secret-value");
    expect(JSON.stringify(engine.historySince(0))).toContain("<redacted secret>");
  });

  it("hosts full Gateway setup with a lockout warning, audited config write, and no restart", async () => {
    useGatewayConfig();
    const appendAuditEntry = installAudit();
    const engine = createEngine({ surface: "gateway" });

    const { portStep, storageStep } = await advanceGatewayWizardToSecretStorage(engine);
    expect(portStep.text).toContain(
      "changing the Gateway port, bind address, or auth credential requires a Gateway restart",
    );
    expect(portStep.text).toContain(
      "sign in to the Control UI again with the new address or credential",
    );
    expect(portStep.text).toContain("Gateway port");

    expect(storageStep.sensitive).not.toBe(true);

    // Choosing plaintext storage generates the secret and writes the config; no secret is typed.
    const done = await engine.handle("1");

    expect(done.text).toContain("Done — gateway settings saved.");
    expect(done.text).toContain("Restart the Gateway to apply them (`restart gateway`).");
    expect(done.text).not.toContain("restarted");
    expect(mocks.writeWizardConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({
          port: 19001,
          bind: "lan",
          auth: expect.objectContaining({
            mode: "token",
            token: expect.stringMatching(/^\S{16,}$/),
          }),
          tailscale: expect.objectContaining({ mode: "off" }),
        }),
      }),
      {
        allowConfigSizeDrop: false,
        baseHash: "gateway-base-hash",
        afterWrite: {
          mode: "none",
          reason: "Gateway setup defers runtime apply until explicit restart",
        },
      },
    );
    expect(appendAuditEntry).toHaveBeenCalledWith({
      operation: "gateway.setup",
      summary: "Configured Gateway via chat setup",
      details: { capability: "gateway" },
    });
    // Nothing was typed, and the generated secret never enters the transcript.
    const written = mocks.writeWizardConfigFile.mock.calls[0]?.[0] as OpenClawConfig | undefined;
    const generatedToken = written?.gateway?.auth?.token;
    expect(typeof generatedToken).toBe("string");
    expect(JSON.stringify(engine.historySince(0))).not.toContain(generatedToken);
  });

  it("rechecks inference authority immediately before a hosted Gateway write", async () => {
    useTempStateDir();
    const baseConfig = useGatewayConfig();
    const changedConfig: OpenClawConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            apiKey: "changed-test-key",
            auth: "api-key",
            models: [],
          },
        },
      },
    };
    const configFixture = await createInferenceConfigFixture(baseConfig);
    const snapshot = configFixture.snapshot;
    const verifiedInference = await createAmbientVerifiedBinding(
      snapshot.runtimeConfig ?? snapshot.config,
      snapshot,
    );
    // The route flips between the final turn's entry gate and the
    // persistent-apply recheck; only the apply boundary can catch it.
    let baseReadsRemaining = Number.POSITIVE_INFINITY;
    mocks.readConfigFileSnapshot.mockImplementation(async () => {
      if (baseReadsRemaining === 0) {
        await configFixture.write(changedConfig);
      }
      baseReadsRemaining -= 1;
      return configFixture.read();
    });
    const engine = createEngine({
      surface: "gateway",
      verifiedInference,
    });

    const { storageStep } = await advanceGatewayWizardToSecretStorage(engine);
    expect(storageStep.text).toContain("store the Gateway");
    baseReadsRemaining = 1;

    const stopped = await engine.handle("1");

    expect(stopped.text).toContain("Gateway setup stopped");
    expect(mocks.writeWizardConfigFile).not.toHaveBeenCalled();
  });

  it("keeps remote Gateway mode guidance-only", async () => {
    const baseConfig: OpenClawConfig = { gateway: { mode: "remote" } };
    useSetupConfig(baseConfig, "remote-gateway-hash");
    const engine = createEngine({ surface: "gateway" });

    const reply = await engine.handle("configure gateway");

    expect(reply.text).toContain("manages only a local Gateway");
    expect(reply.text).toContain("`openclaw onboard` for fresh setup");
    expect(reply.text).toContain("`openclaw configure` for the mode question");
    expect(reply.text).not.toContain("Gateway port");
    expect(mocks.writeWizardConfigFile).not.toHaveBeenCalled();
  });

  it.each([
    ["gateway", "runHostedGatewaySetup", "Gateway token"],
    ["search", "runHostedSearchSetup", "Provider API key"],
  ] as const)(
    "hands CLI %s credentials to the masked terminal wizard",
    async (target, wizard, message) => {
      vi.spyOn(hostedSetup, wizard).mockImplementationOnce(async (prompter) => {
        await prompter.text({ message, sensitive: true });
        return "applied";
      });
      const engine = createEngine({ surface: "cli" });
      const stopped = await engine.handle(`configure ${target}`);
      expect(stopped.text).toContain("Sensitive input is not accepted");
      expect(stopped.text).toContain(`open ${target} wizard`);
      if (target === "gateway") {
        expect(stopped.text).toContain("openclaw configure --section gateway");
      }
      expect(stopped.sensitive).toBeUndefined();
      const handoff = await engine.handle(`open ${target} wizard`);
      expect(handoff.action).toBe("open-setup");
      expect(handoff.handoff).toEqual({ kind: "open-setup", target });
    },
  );

  it("reports a failed hosted search-provider install without writing or auditing", async () => {
    const baseConfig: OpenClawConfig = {};
    const appendAuditEntry = installAudit();
    useSetupConfig(baseConfig, "search-base-hash");
    mocks.runSearchSetupFlow.mockResolvedValue({
      outcome: "install-failed",
      config: baseConfig,
      providerId: "brave",
      reason: "failed",
    });
    const engine = createEngine({ surface: "gateway" });

    const reply = await engine.handle("configure search");

    expect(reply.text).toContain(
      "Web search setup stopped: web search provider brave installation failed",
    );
    expect(reply.text).not.toContain("Done — web search setup is complete");
    expect(mocks.writeWizardConfigFile).not.toHaveBeenCalled();
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("does not promise Doctor will repair every invalid channel setup config", async () => {
    mocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      path: "/tmp/openclaw.json",
      hash: "invalid-hash",
      config: {},
      sourceConfig: {},
      issues: [{ path: "gateway.port", message: "Expected number" }],
    });
    const engine = createEngine();

    const reply = await engine.handle("connect telegram");

    expect(reply.text).toContain("machine running OpenClaw");
    expect(reply.text).toContain("openclaw doctor --fix");
    expect(reply.text).toContain("remaining validation errors");
    expect(reply.text).not.toContain("repairs it");
  });

  it("reports hosted channel setup success when audit persistence fails", async () => {
    const appendAuditEntry = installAudit().mockRejectedValue(
      new Error("audit store is read-only"),
    );
    vi.spyOn(hostedSetup, "runHostedChannelSetup").mockImplementationOnce(async (channel) => {
      expect(channel).toBe("telegram");
      return "applied";
    });
    const engine = createEngine();

    const reply = await engine.handle("connect telegram");

    expect(reply.text).toContain("Done — telegram is configured.");
    expect(reply.question).toBeUndefined();
    expect(reply.text).not.toContain("audit store is read-only");
    expect(appendAuditEntry).toHaveBeenCalledOnce();
  });

  it.each(["config revision", "write", "post-write hooks"] as const)(
    "rejects stale hosted channel authority at %s",
    async (phase) => {
      useTempStateDir();
      const revisionConflict = phase === "config revision";
      const baseConfig = channelConfig();
      if (revisionConflict) {
        delete baseConfig.models;
      }
      const changedConfig: OpenClawConfig = {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-8" } } },
      };
      if (revisionConflict) {
        changedConfig.auth = {
          profiles: { "anthropic:main": { provider: "anthropic", mode: "api_key" } },
        };
      }
      let currentConfig = structuredClone(baseConfig);
      let currentHash = "base-hash";
      const configFixture = revisionConflict
        ? undefined
        : await createInferenceConfigFixture(baseConfig);
      const snapshot = configFixture?.snapshot;
      const verifiedInference = snapshot
        ? await createAmbientVerifiedBinding(snapshot.runtimeConfig ?? snapshot.config, snapshot)
        : undefined;
      if (configFixture) {
        mocks.readConfigFileSnapshot.mockImplementation(configFixture.read);
      }
      const hook = { channel: "telegram", accountId: "default", run: vi.fn() };
      mocks.readSetupConfigFileSnapshot.mockImplementation(async () => {
        const config = revisionConflict ? currentConfig : baseConfig;
        return {
          ...setupSnapshot(structuredClone(config), currentHash),
          sourceConfig: structuredClone(config),
          path: "/tmp/openclaw.json",
          issues: [],
        };
      });
      useChannelSetup(async (config, prompter, options) => {
        const token = await prompter.text({ message: "Bot token" });
        if (phase === "write") {
          currentConfig = structuredClone(changedConfig);
          await configFixture?.write(currentConfig);
        } else if (phase === "post-write hooks") {
          options.onPostWriteHook?.(hook);
        }
        return {
          ...config,
          channels: { ...config.channels, telegram: { botToken: token } },
        };
      });
      mocks.writeWizardConfigFile.mockImplementation(
        async (config: OpenClawConfig, opts: { baseHash?: string }) => {
          if (revisionConflict && opts.baseHash !== currentHash) {
            throw new Error("configuration changed during channel setup");
          }
          currentConfig = structuredClone(phase === "post-write hooks" ? changedConfig : config);
          await configFixture?.write(currentConfig);
          if (revisionConflict) {
            currentHash = "committed-hash";
          }
          return hostedConfigFiles.write(config);
        },
      );
      const engine = createEngine({
        surface: "gateway",
        ...(!revisionConflict && {
          verifiedInference,
        }),
      });
      const tokenStep = await engine.handle("connect telegram");
      expect(tokenStep.text).toContain("Bot token");
      expect(tokenStep.question).toBeUndefined();
      if (revisionConflict) {
        currentConfig = structuredClone(changedConfig);
        currentHash = "concurrent-hash";
      }
      const stopped = await engine.handle("123:abc");

      expect(stopped.text).toContain("Telegram setup stopped");
      if (revisionConflict) {
        expect(stopped.text).toContain("configuration changed during channel setup");
        expect(mocks.writeWizardConfigFile).toHaveBeenCalledWith(
          expect.objectContaining({
            channels: expect.objectContaining({ telegram: { botToken: "123:abc" } }),
          }),
          expect.objectContaining({ baseHash: "base-hash" }),
        );
        expect(currentConfig).toEqual(changedConfig);
      } else if (phase === "write") {
        expect(mocks.writeWizardConfigFile).not.toHaveBeenCalled();
      } else {
        expect(mocks.writeWizardConfigFile).toHaveBeenCalledOnce();
        expect(hook.run).not.toHaveBeenCalled();
      }
    },
  );
});

describe("hosted channel post-write hooks", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  it("ChatWizardHost.startChannel owns plugin resources through deferred hooks without retiring Gateway boot", async () => {
    await using bootCache = createPluginCache({ kind: "process" });
    const fixture = createInstallAccountPolicyFixture(
      tempDirs.make("openclaw-hosted-install-policy-"),
      "signal",
    );
    const baseConfig = fixture.config;
    const metadataSnapshot = fixture.readMetadata();
    const resolveMetadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
      .mockImplementation(({ config, workspaceDir }) => fixture.readMetadata(config, workspaceDir));
    const readAccount: ChannelPlugin["config"]["resolveAccount"] = (config, accountId) =>
      resolveChannelAccountEntry(
        config.channels?.signal?.accounts,
        normalizeAccountId(accountId),
        "signal",
      );
    bindPluginMetadataSnapshotCache(metadataSnapshot, bootCache);
    const pluginRegistry = createEmptyPluginRegistry();
    const bootInstance = new PluginInstance("gateway-boot");
    bootCache.instances.add(bootInstance);
    const readBoot = bootInstance.wrap(() => "Gateway available");
    pluginRegistry.channels.push({
      pluginId: "signal",
      source: "test",
      plugin: createChannelTestPluginBase({
        id: "signal",
        config: { resolveAccount: bootInstance.wrap(readAccount) },
      }),
    });
    const setupInstance = new PluginInstance("chat-channel-setup");
    const events: string[] = [];
    const caches: PluginCache[] = [];
    const readSetup = setupInstance.wrap(() => "post-write complete");
    setupInstance.lifecycle.onDispose(() => {
      events.push("disposed");
    });
    const hookStarted = createDeferred();
    const finishHook = createDeferred();
    const observedScope = createDeferred<{
      metadata: ReturnType<typeof getCurrentPluginMetadataSnapshot>;
      registry: ReturnType<typeof getPluginRuntimeGenerationRegistry>;
    }>();
    const recordPhase = (phase: string) => {
      events.push(phase);
      caches.push(getPluginCache());
    };
    const hook = {
      channel: "signal",
      accountId: "work-phone",
      run: async ({ cfg }: { cfg: OpenClawConfig }) => {
        expect(hasPluginLifecycleLease()).toBe(false);
        expect(readAccount(cfg, "work-phone")).toEqual({
          account: "+12025550123",
          name: "Work calls",
        });
        events.push("after-write");
        hookStarted.resolve();
        await finishHook.promise;
        events.push(readSetup());
      },
    };
    mocks.readSetupConfigFileSnapshot.mockImplementation(async () => {
      recordPhase("read");
      getPluginCache().instances.add(setupInstance);
      observedScope.resolve({
        metadata: getCurrentPluginMetadataSnapshot(),
        registry: getPluginRuntimeGenerationRegistry(),
      });
      return setupSnapshot(baseConfig, "setup-base-hash");
    });
    useChannelSetup(async (config, _prompter, options) => {
      recordPhase("setup");
      await withCommandPluginMetadata({ config }, () => {
        expect(readAccount(config, "work-phone")).toBeUndefined();
      });
      await withPluginLifecycleLease({ env: fixture.env }, async () => {
        fixture.installPolicy();
      });
      recordPhase("installed");
      options.onPostWriteHook?.(hook);
      return await withCommandPluginMetadata({ config }, () =>
        applyAccountNameToChannelSection({
          cfg: config,
          channelKey: "signal",
          accountId: "work-phone",
          name: "Work calls",
        }),
      );
    });
    mocks.writeWizardConfigFile.mockImplementation(async (config: OpenClawConfig) => {
      recordPhase("write");
      expect(config.channels?.signal?.accounts).toEqual({
        "Work Phone": { account: "+12025550123", name: "Work calls" },
      });
      return hostedConfigFiles.write(config);
    });
    const host = new ChatWizardHost({
      surface: "gateway",
      beforePersistentApply: async () => {
        recordPhase("authorize");
      },
    });
    const running = withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, () =>
      host.startChannel("signal"),
    );

    try {
      await Promise.race([
        hookStarted.promise,
        running.then(() => {
          throw new Error("chat setup completed before its post-write hook");
        }),
      ]);
      expect(await observedScope.promise).toEqual({ metadata: undefined, registry: undefined });
      expect(caches[0]).not.toBe(bootCache);
      expect(caches.slice(0, 4).every((cache) => cache === caches[0])).toBe(true);
      expect(events).toEqual([
        "read",
        "setup",
        "installed",
        "authorize",
        "write",
        "authorize",
        "after-write",
      ]);
      expect(readSetup()).toBe("post-write complete");
      finishHook.resolve();
      expect((await running).text).toContain("signal is configured");
      expect(events.slice(-2)).toEqual(["post-write complete", "disposed"]);
      expect(() => readSetup()).toThrow("reloaded or disabled");
      withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, () => {
        expect(getCurrentPluginMetadataSnapshot()).toBe(metadataSnapshot);
        expect(getPluginRuntimeGenerationRegistry()).toBe(pluginRegistry);
        expect(pluginRegistry.channels).toHaveLength(1);
        expect(
          pluginRegistry.channels[0]?.plugin.config.resolveAccount(baseConfig, "work-phone"),
        ).toBeUndefined();
        expect(readBoot()).toBe("Gateway available");
      });
    } finally {
      finishHook.resolve();
      await running;
      await setupInstance.dispose();
      host.dispose();
      resolveMetadata.mockRestore();
    }
  });

  it("runs collected channel hooks after writing config", async () => {
    const hook = { channel: "matrix", accountId: "default", run: vi.fn() };
    mocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      hash: "hook-base-hash",
      config: {},
      sourceConfig: {},
    });
    mocks.setupChannels.mockImplementation(
      async (
        _config: OpenClawConfig,
        _runtime: unknown,
        _prompter: WizardPrompter,
        options: { onPostWriteHook?: (value: typeof hook) => void },
      ) => {
        options.onPostWriteHook?.(hook);
        return { channels: { matrix: { enabled: true } } };
      },
    );
    const committed = { channels: { matrix: { enabled: true, committed: true } } };
    mocks.writeWizardConfigFile.mockResolvedValue(hostedConfigFiles.write(committed));
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("connect matrix");

    expect(reply.text).toContain("matrix is configured");
    expect(mocks.writeWizardConfigFile).toHaveBeenCalledWith(
      { channels: { matrix: { enabled: true } } },
      { allowConfigSizeDrop: false, baseHash: "hook-base-hash" },
    );
    expect(hook.run).toHaveBeenCalledWith({
      cfg: committed,
      runtime: expect.any(Object),
    });
    expect(mocks.writeWizardConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      hook.run.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});
