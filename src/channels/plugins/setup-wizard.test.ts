import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import {
  createQueuedWizardPrompter,
  runSetupWizardConfigure,
} from "../../test-utils/plugin-setup-wizard.js";
import { defineChannelSetupContract } from "./setup-contract.js";
import { patchScopedAccountConfig } from "./setup-helpers.js";
import type { ChannelSetupPlugin, ChannelSetupWizard } from "./setup-wizard-types.js";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "./setup-wizard.js";

type AccountConfig = {
  botId?: string;
  secret?: string;
  enabled?: boolean;
  marker?: { keep: string };
};

type ChannelConfig = AccountConfig & {
  defaultAccount?: string;
  accounts?: Record<string, AccountConfig>;
};

const mainCredentials = { botId: "test-main-bot-id", secret: "test-secret" };
const alertCredentials = { botId: "test-alerts-bot-id", secret: "example-secret" };

function newAccountPrompter() {
  return createQueuedWizardPrompter({
    selectValues: ["__new__"],
    textValues: ["alerts", alertCredentials.botId, alertCredentials.secret],
  });
}

function expectPromotion(
  result: { cfg: OpenClawConfig },
  queued: ReturnType<typeof createQueuedWizardPrompter>,
  accounts: ChannelConfig["accounts"],
) {
  const channel = getChannelConfig(result.cfg);
  expect(channel).not.toHaveProperty("botId");
  expect(channel).not.toHaveProperty("secret");
  expect(channel.accounts).toEqual(accounts);
  expect(queued.confirm).not.toHaveBeenCalled();
  return channel;
}

function getChannelConfig(cfg: OpenClawConfig): ChannelConfig {
  return ((cfg.channels as Record<string, unknown> | undefined)?.demo ?? {}) as ChannelConfig;
}

function resolveDefaultAccountId(cfg: OpenClawConfig): string {
  const channel = getChannelConfig(cfg);
  return normalizeAccountId(
    channel.defaultAccount ?? Object.keys(channel.accounts ?? {})[0] ?? DEFAULT_ACCOUNT_ID,
  );
}

function resolveLegacyAccount(cfg: OpenClawConfig): AccountConfig {
  const channel = getChannelConfig(cfg);
  return {
    ...channel,
    ...channel.accounts?.[resolveDefaultAccountId(cfg)],
  };
}

function setLegacyAccount(cfg: OpenClawConfig, patch: AccountConfig): OpenClawConfig {
  const channel = getChannelConfig(cfg);
  const accountId = resolveDefaultAccountId(cfg);
  const updated = channel.accounts
    ? {
        ...channel,
        accounts: {
          ...channel.accounts,
          [accountId]: { ...channel.accounts[accountId], ...patch },
        },
      }
    : { ...channel, ...patch };
  return {
    ...cfg,
    channels: { ...cfg.channels, demo: updated },
  } as OpenClawConfig;
}

function createLegacyPlugin(): ChannelSetupPlugin {
  return {
    ...createChannelTestPluginBase({
      id: "demo",
      label: "Demo",
      config: {
        listAccountIds: (cfg) => {
          const ids = Object.keys(getChannelConfig(cfg).accounts ?? {});
          return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
        },
        defaultAccountId: resolveDefaultAccountId,
      },
    }),
    setup: {
      applyAccountConfig: ({ cfg, input }) =>
        setLegacyAccount(cfg, {
          botId: typeof input.token === "string" ? input.token : undefined,
          secret: typeof input.privateKey === "string" ? input.privateKey : undefined,
        }),
    },
  };
}

function credential(
  inputKey: "token" | "privateKey",
  field: "botId" | "secret",
  credentialLabel: string,
): ChannelSetupWizard["credentials"][number] {
  return {
    inputKey,
    providerHint: "Demo",
    credentialLabel,
    envPrompt: `Use ${credentialLabel} from environment?`,
    keepPrompt: `${credentialLabel} already configured. Keep it?`,
    inputPrompt: credentialLabel,
    inspect: ({ cfg }) => {
      const value = resolveLegacyAccount(cfg)[field];
      return {
        accountConfigured: Boolean(value),
        hasConfiguredValue: Boolean(value),
        resolvedValue: value,
      };
    },
    applySet: ({ cfg, resolvedValue }) => setLegacyAccount(cfg, { [field]: resolvedValue }),
  };
}

function createLegacyWizard(): ChannelSetupWizard {
  return {
    channel: "demo",
    status: {
      configuredLabel: "Configured",
      unconfiguredLabel: "Not configured",
      resolveConfigured: ({ cfg }) => Boolean(resolveLegacyAccount(cfg).botId),
    },
    credentials: [
      credential("token", "botId", "Bot ID"),
      credential("privateKey", "secret", "Token"),
    ],
  };
}

function configure(
  channel: ChannelConfig,
  queued: ReturnType<typeof createQueuedWizardPrompter>,
  setup = { plugin: createLegacyPlugin(), wizard: createLegacyWizard() },
  accountOverrides?: Record<string, string>,
) {
  return runSetupWizardConfigure({
    configure: buildChannelSetupWizardAdapterFromSetupWizard(setup).configure,
    cfg: { channels: { demo: channel } } as OpenClawConfig,
    prompter: queued.prompter,
    shouldPromptAccountIds: !accountOverrides,
    accountOverrides,
    options: { secretInputMode: "plaintext" as const },
  });
}

describe("channel setup wizard account scoping", () => {
  it("preserves an owned root through declarative guided account setup", async () => {
    const root = { botId: "root-bot", secret: "root-secret", name: "Root" };
    const plugin = createLegacyPlugin();
    plugin.setupContract = defineChannelSetupContract({
      fields: {
        token: { kind: "string", cli: { flags: "--token <token>", description: "Bot ID" } },
        useEnv: { kind: "boolean", cli: { flags: "--use-env", description: "Use environment" } },
      },
      adapter: {
        configPromotion: "preserve-root",
        applyAccountConfig: ({ cfg, accountId, input }) =>
          patchScopedAccountConfig({
            cfg,
            channelKey: "demo",
            accountId,
            patch: { botId: input.token },
            ensureAccountEnabled: false,
            ensureChannelEnabled: false,
          }),
      },
    });
    const wizard = createLegacyWizard();
    wizard.credentials = [
      {
        ...wizard.credentials[0]!,
        inspect: ({ cfg, accountId }) => ({
          accountConfigured: Boolean(
            getChannelConfig(cfg).accounts?.[accountId ?? "default"]?.botId,
          ),
          hasConfiguredValue: Boolean(
            getChannelConfig(cfg).accounts?.[accountId ?? "default"]?.botId,
          ),
        }),
        applySet: undefined,
      },
    ];
    const queued = createQueuedWizardPrompter({
      selectValues: ["__new__"],
      textValues: ["ada", "ada-bot"],
    });
    const result = await configure(root, queued, { plugin, wizard });
    expect(result.accountId).toBe("ada");
    expect(result.cfg.channels?.demo).toEqual({
      ...root,
      accounts: { ada: { botId: "ada-bot" } },
    });
    expect(queued.confirm).not.toHaveBeenCalled();
  });

  it("promotes mixed root credentials before adding another named account", async () => {
    const queued = newAccountPrompter();

    const result = await configure(
      {
        defaultAccount: "main",
        ...mainCredentials,
        accounts: { main: { marker: { keep: "mixed-shape" } } },
      },
      queued,
    );

    const channel = expectPromotion(result, queued, {
      main: { ...mainCredentials, marker: { keep: "mixed-shape" } },
      alerts: alertCredentials,
    });
    expect(channel.defaultAccount).toBe("main");
  });

  it("scopes a named default account when another account is the channel default", async () => {
    const main = { ...mainCredentials };
    const before = JSON.stringify(main);
    const queued = createQueuedWizardPrompter({
      confirmValues: [false, false],
      textValues: ["test-new-bot-id", "mock-secret"],
    });

    const result = await configure(
      {
        defaultAccount: "main",
        accounts: {
          default: { botId: "test-old-bot-id", secret: "fixture-secret" },
          main,
        },
      },
      queued,
      undefined,
      { demo: DEFAULT_ACCOUNT_ID },
    );

    const channel = getChannelConfig(result.cfg);
    expect(channel.defaultAccount).toBe("main");
    expect(JSON.stringify(channel.accounts?.main)).toBe(before);
    expect(channel.accounts?.default).toEqual({
      botId: "test-new-bot-id",
      secret: "mock-secret",
    });
    expect(queued.confirm).toHaveBeenCalledTimes(2);
  });

  it("promotes root credentials before adding the first named account", async () => {
    const queued = newAccountPrompter();

    const result = await configure({ enabled: true, ...mainCredentials }, queued);

    const channel = expectPromotion(result, queued, {
      default: mainCredentials,
      alerts: alertCredentials,
    });
    expect(channel).not.toHaveProperty("defaultAccount");
  });
});
