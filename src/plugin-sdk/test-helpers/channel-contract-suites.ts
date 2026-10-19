import { expect, it } from "vitest";
import { resolveChannelSetupExecutionAdapter } from "../../channels/plugins/setup-contract.js";
import type { ChannelSetupDmPolicy } from "../../channels/plugins/setup-wizard-types.js";
import type {
  ChannelAccountSnapshot,
  ChannelAccountState,
  ChannelSetupInput,
} from "../../channels/plugins/types.core.js";
import type {
  ChannelMessageActionName,
  ChannelMessageCapability,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";

function sortStrings(values: readonly string[]) {
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

export function expectChannelPluginContract(
  plugin: Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config">,
) {
  expect(typeof plugin.id).toBe("string");
  expect(
    [plugin.id, plugin.meta.label, plugin.meta.selectionLabel, plugin.meta.blurb].map((value) =>
      value.trim(),
    ),
  ).not.toContain("");
  expect(plugin.meta.id).toBe(plugin.id);
  expect(plugin.meta.docsPath).toMatch(/^\/channels\//);
  expect(plugin.capabilities.chatTypes.length).toBeGreaterThan(0);
  expect(plugin.config).toMatchObject({
    listAccountIds: expect.any(Function),
    resolveAccount: expect.any(Function),
  });
}

type ChannelContractCase = {
  name: string;
  cfg: OpenClawConfig;
  beforeTest?: () => void;
};

type ChannelActionsContractCase = ChannelContractCase & {
  expectedActions: readonly ChannelMessageActionName[];
  expectedCapabilities?: readonly ChannelMessageCapability[];
};

export function installChannelActionsContractSuite(params: {
  plugin: Pick<ChannelPlugin, "id" | "actions">;
  cases: readonly ChannelActionsContractCase[];
  unsupportedAction?: ChannelMessageActionName;
}) {
  it("exposes the base message actions contract", () => {
    expect(typeof params.plugin.actions?.describeMessageTool).toBe("function");
  });

  for (const testCase of params.cases) {
    it(`actions contract: ${testCase.name}`, () => {
      testCase.beforeTest?.();

      const discovery = params.plugin.actions?.describeMessageTool({ cfg: testCase.cfg });
      const actions = Array.isArray(discovery?.actions) ? [...discovery.actions] : [];
      const capabilities = Array.isArray(discovery?.capabilities) ? discovery.capabilities : [];

      expect(actions).toEqual([...new Set(actions)]);
      expect(capabilities).toEqual([...new Set(capabilities)]);
      expect(sortStrings(actions)).toEqual(sortStrings(testCase.expectedActions));
      expect(sortStrings(capabilities)).toEqual(sortStrings(testCase.expectedCapabilities ?? []));

      if (
        params.plugin.actions?.supportsAction &&
        params.unsupportedAction &&
        !testCase.expectedActions.includes(params.unsupportedAction)
      ) {
        expect(params.plugin.actions.supportsAction({ action: params.unsupportedAction })).toBe(
          false,
        );
      }
    });
  }
}

type ChannelSetupContractCase<
  ResolvedAccount,
  SetupInput extends ChannelSetupInput,
> = ChannelContractCase & {
  accountId?: string;
  input: SetupInput;
  expectedAccountId?: string;
  expectedValidation?: string | null;
  assertPatchedConfig?: (cfg: OpenClawConfig) => void;
  assertResolvedAccount?: (account: ResolvedAccount, cfg: OpenClawConfig) => void;
};

export function installChannelSetupContractSuite<
  ResolvedAccount,
  SetupInput extends ChannelSetupInput = ChannelSetupInput,
>(params: {
  plugin: Pick<ChannelPlugin<ResolvedAccount>, "id" | "config" | "setup">;
  cases: readonly ChannelSetupContractCase<ResolvedAccount, SetupInput>[];
}) {
  const setup = resolveChannelSetupExecutionAdapter(
    params.plugin as Pick<ChannelPlugin<ResolvedAccount>, "setup" | "setupContract">,
  );
  it("exposes the base setup contract", () => {
    expect(typeof setup?.applyAccountConfig).toBe("function");
  });

  for (const testCase of params.cases) {
    it(`setup contract: ${testCase.name}`, () => {
      testCase.beforeTest?.();

      const input = { cfg: testCase.cfg, accountId: testCase.accountId, input: testCase.input };
      const resolvedAccountId = setup?.resolveAccountId?.(input) ?? testCase.accountId ?? "default";
      const patch = { ...input, accountId: resolvedAccountId };

      expect(resolvedAccountId).toBe(testCase.expectedAccountId ?? resolvedAccountId);

      const validation = setup?.validateInput?.(patch) ?? null;
      expect(validation).toBe(testCase.expectedValidation ?? null);

      const nextCfg = setup?.applyAccountConfig(patch);
      expect(nextCfg).toBeDefined();

      const account = params.plugin.config.resolveAccount(nextCfg!, resolvedAccountId);
      testCase.assertPatchedConfig?.(nextCfg!);
      testCase.assertResolvedAccount?.(account, nextCfg!);
    });
  }
}

type ChannelDmPolicyConfig = {
  dmPolicy?: unknown;
  allowFrom?: unknown;
  accounts?: Record<string, ChannelDmPolicyConfig | undefined>;
};

type ChannelDmPolicyContractCase = {
  name: string;
  channel: string;
  accountId: string;
  accountConfig: Record<string, unknown>;
  inheritedAllowFrom: ReadonlyArray<string | number>;
  defaultAccount?: {
    rootAllowFrom?: ReadonlyArray<string | number>;
    accountAllowFrom?: ReadonlyArray<string | number>;
  };
};

function createDmPolicyContractConfig(
  testCase: ChannelDmPolicyContractCase,
  mode: "read" | "write" | "default",
): OpenClawConfig {
  const defaultAccount = mode === "default" ? testCase.defaultAccount : undefined;
  const account = {
    ...testCase.accountConfig,
    ...(mode === "write" ? {} : { dmPolicy: "allowlist" }),
    ...(defaultAccount?.accountAllowFrom
      ? { allowFrom: [...defaultAccount.accountAllowFrom] }
      : {}),
  };
  const rootAllowFrom =
    mode === "write" ? testCase.inheritedAllowFrom : defaultAccount?.rootAllowFrom;
  return {
    channels: {
      [testCase.channel]: {
        ...(mode === "write" ? {} : { dmPolicy: "disabled" }),
        ...(mode === "default" ? { defaultAccount: testCase.accountId } : {}),
        ...(rootAllowFrom ? { allowFrom: [...rootAllowFrom] } : {}),
        accounts: { [testCase.accountId]: account },
      },
    },
  } as OpenClawConfig;
}

function addExpectedWildcard(values: ReadonlyArray<string | number> | undefined) {
  return values?.includes("*") ? [...values] : [...(values ?? []), "*"];
}

function resolveDmPolicyConfig(
  cfg: OpenClawConfig,
  channel: string,
  accountId: string,
): { channel: ChannelDmPolicyConfig; account: ChannelDmPolicyConfig } {
  const channels = cfg.channels as Record<string, ChannelDmPolicyConfig | undefined> | undefined;
  const channelConfig = channels?.[channel];
  const accountConfig = channelConfig?.accounts?.[accountId];
  expect(accountConfig).toBeDefined();
  return { channel: channelConfig!, account: accountConfig! };
}

export function installChannelDmPolicyContractSuite(params: {
  dmPolicy: ChannelSetupDmPolicy;
  cases: readonly ChannelDmPolicyContractCase[];
}) {
  const { dmPolicy } = params;
  for (const testCase of params.cases) {
    const { channel, accountId, defaultAccount } = testCase;
    const config = (mode: "read" | "write" | "default") =>
      createDmPolicyContractConfig(testCase, mode);
    const expectKeys = (cfg: OpenClawConfig, id?: string) =>
      expect(dmPolicy.resolveConfigKeys?.(cfg, id)).toEqual({
        policyKey: `channels.${channel}.accounts.${accountId}.dmPolicy`,
        allowFromKey: `channels.${channel}.accounts.${accountId}.allowFrom`,
      });
    const expectOpenPatch = (
      cfg: OpenClawConfig,
      values: ReadonlyArray<string | number> | undefined,
      id?: string,
    ) => {
      const before = resolveDmPolicyConfig(cfg, channel, accountId);
      const root = {
        dmPolicy: before.channel.dmPolicy,
        allowFrom: Array.isArray(before.channel.allowFrom)
          ? [...before.channel.allowFrom]
          : before.channel.allowFrom,
      };
      const next = dmPolicy.setPolicy(cfg, "open", id);
      const after = resolveDmPolicyConfig(next, channel, accountId);
      expect({ dmPolicy: after.channel.dmPolicy, allowFrom: after.channel.allowFrom }).toEqual(
        root,
      );
      expect({ dmPolicy: after.account.dmPolicy, allowFrom: after.account.allowFrom }).toEqual({
        dmPolicy: "open",
        allowFrom: addExpectedWildcard(values),
      });
    };
    it(`dm policy contract: ${testCase.name} reads the named-account policy`, () => {
      expect(dmPolicy.channel).toBe(channel);
      expect(dmPolicy.getCurrent(config("read"), accountId)).toBe("allowlist");
    });
    it(`dm policy contract: ${testCase.name} reports account-scoped config keys`, () => {
      expectKeys({}, accountId);
    });
    it(`dm policy contract: ${testCase.name} writes open policy with inherited allowFrom`, () => {
      expectOpenPatch(config("write"), testCase.inheritedAllowFrom, accountId);
    });
    if (defaultAccount) {
      it(`dm policy contract: ${testCase.name} uses defaultAccount when accountId is omitted`, () => {
        const cfg = config("default");
        expect(dmPolicy.getCurrent(cfg)).toBe("allowlist");
        expectKeys(cfg);
        expectOpenPatch(cfg, defaultAccount.accountAllowFrom ?? defaultAccount.rootAllowFrom);
      });
    }
  }
}

type ChannelStatusContractCase<Probe> = ChannelContractCase & {
  accountId?: string;
  runtime?: ChannelAccountSnapshot;
  probe?: Probe;
  expectedState?: ChannelAccountState;
  resolveStateInput?: {
    configured: boolean;
    enabled: boolean;
  };
  assertSnapshot?: (snapshot: ChannelAccountSnapshot) => void;
  assertSummary?: (summary: Record<string, unknown>) => void;
};

export function installChannelStatusContractSuite<ResolvedAccount, Probe = unknown>(params: {
  plugin: Pick<ChannelPlugin<ResolvedAccount, Probe>, "id" | "config" | "status">;
  cases: readonly ChannelStatusContractCase<Probe>[];
}) {
  it("exposes the base status contract", () => {
    expect(typeof params.plugin.status?.buildAccountSnapshot).toBe("function");
  });

  if (params.plugin.status?.defaultRuntime) {
    it("status contract: default runtime is shaped like an account snapshot", () => {
      expect(typeof params.plugin.status?.defaultRuntime?.accountId).toBe("string");
    });
  }

  for (const testCase of params.cases) {
    it(`status contract: ${testCase.name}`, async () => {
      testCase.beforeTest?.();
      const { config, status } = params.plugin;
      const base = {
        cfg: testCase.cfg,
        account: config.resolveAccount(testCase.cfg, testCase.accountId),
      };
      const snapshot = await status!.buildAccountSnapshot!({
        ...base,
        runtime: testCase.runtime,
        probe: testCase.probe,
      });

      expect(typeof snapshot.accountId).toBe("string");
      expect(snapshot.accountId.trim()).not.toBe("");
      testCase.assertSnapshot?.(snapshot);

      if (status?.buildChannelSummary) {
        const defaultAccountId =
          config.defaultAccountId?.(testCase.cfg) ?? testCase.accountId ?? "default";
        const summary = await status.buildChannelSummary({
          ...base,
          defaultAccountId,
          snapshot,
        });
        expect(summary).toEqual(expect.any(Object));
        testCase.assertSummary?.(summary);
      }

      if (testCase.expectedState && status?.resolveAccountState) {
        const state = status.resolveAccountState({
          ...base,
          configured: testCase.resolveStateInput?.configured ?? true,
          enabled: testCase.resolveStateInput?.enabled ?? true,
        });
        expect(state).toBe(testCase.expectedState);
      }
    });
  }
}
