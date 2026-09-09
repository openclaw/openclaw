import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err as resultError, ok, type Result } from "@openclaw/normalization-core/result";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  resolveChannelSetupExecutionAdapter,
  type ChannelSetupFieldMetadata,
} from "./setup-contract.js";
import { moveSingleAccountChannelSectionToDefaultAccount } from "./setup-helpers.js";
import type { ChannelSetupAdapter } from "./types.adapters.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

export type ChannelAccountMutationPlugin = Pick<
  ChannelPlugin,
  "id" | "meta" | "config" | "setup" | "setupContract" | "gateway" | "lifecycle"
>;

type ChannelSetupExecutionAdapter = NonNullable<
  ReturnType<typeof resolveChannelSetupExecutionAdapter>
>;

type ChannelAccountConfigurationError =
  | { kind: "unsupported" }
  | { kind: "invalid-input"; message: string };

type PreparedChannelAccountConfiguration = {
  plugin: ChannelAccountMutationPlugin;
  setup: ChannelSetupExecutionAdapter;
  applyAccountConfig: NonNullable<ChannelSetupExecutionAdapter["applyAccountConfig"]>;
  accountId: string;
  input: unknown;
};

function resolveMissingSetupEnvMessage(
  plugin: ChannelAccountMutationPlugin,
  input: unknown,
): string | undefined {
  if (!plugin.setupContract || !isRecord(input) || input.useEnv !== true) {
    return undefined;
  }
  const useEnvField = plugin.setupContract.metadata.fields.find(
    (field): field is Extract<ChannelSetupFieldMetadata, { kind: "boolean" }> =>
      field.kind === "boolean" && field.key === "useEnv",
  );
  if (!useEnvField?.envVars?.length) {
    return undefined;
  }
  const { envVars, envVarMode } = useEnvField;
  const missing = envVars.filter((name) => !process.env[name]?.trim());
  const ready = envVarMode === "any" ? missing.length < envVars.length : !missing.length;
  if (ready) {
    return undefined;
  }
  return envVarMode === "any"
    ? `Set one of these environment variables before using --use-env: ${missing.join(", ")}.`
    : `Set these environment variables before using --use-env: ${missing.join(", ")}.`;
}

export async function prepareChannelAccountConfiguration(params: {
  cfg: OpenClawConfig;
  plugin: ChannelAccountMutationPlugin;
  requestedAccountId?: string;
  resolveInput: () => unknown;
  runtime: RuntimeEnv;
  beforePersistentEffect?: () => Promise<void>;
}): Promise<Result<PreparedChannelAccountConfiguration, ChannelAccountConfigurationError>> {
  const setup = resolveChannelSetupExecutionAdapter(params.plugin);
  if (!setup?.applyAccountConfig) {
    return resultError({ kind: "unsupported" });
  }

  // Input resolution can perform plugin-owned reads. Keep it behind setup
  // capability discovery so unsupported channels retain their existing failure path.
  const rawInput = params.resolveInput();
  let input: unknown;
  if (params.plugin.setupContract) {
    const parsed = params.plugin.setupContract.parseInput(rawInput);
    if (!parsed.ok) {
      return resultError({ kind: "invalid-input", message: parsed.error });
    }
    input = parsed.value;
  } else {
    input = rawInput;
  }

  const accountId =
    setup.resolveAccountId?.({
      cfg: params.cfg,
      accountId: params.requestedAccountId,
      input,
    }) ?? normalizeAccountId(params.requestedAccountId);
  if (setup.prepareAccountConfigInput) {
    await params.beforePersistentEffect?.();
    input = await setup.prepareAccountConfigInput({
      cfg: params.cfg,
      accountId,
      input,
      runtime: params.runtime,
    });
  }

  const validationError = setup.validateInput?.({
    cfg: params.cfg,
    accountId,
    input,
  });
  if (validationError) {
    return resultError({ kind: "invalid-input", message: validationError });
  }
  const missingEnvMessage = resolveMissingSetupEnvMessage(params.plugin, input);
  if (missingEnvMessage) {
    return resultError({ kind: "invalid-input", message: missingEnvMessage });
  }

  return ok({
    plugin: params.plugin,
    setup,
    applyAccountConfig: setup.applyAccountConfig,
    accountId,
    input,
  });
}

export async function applyPreparedChannelAccountConfiguration(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  prepared: PreparedChannelAccountConfiguration;
  runtime: RuntimeEnv;
  beforePersistentEffect?: () => Promise<void>;
}): Promise<{
  nextConfig: OpenClawConfig;
  accountId: string;
  input: unknown;
  afterAccountConfigWritten?: ChannelSetupExecutionAdapter["afterAccountConfigWritten"];
}> {
  const { accountId, applyAccountConfig, input, plugin, setup } = params.prepared;
  const configAccountId = normalizeAccountId(accountId);
  let nextConfig = params.cfg;
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    nextConfig = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: nextConfig,
      channelKey: params.channel,
      setupSurface: setup as ChannelSetupAdapter,
    });
  }
  nextConfig = applyAccountConfig({
    cfg: nextConfig,
    accountId: configAccountId,
    input,
  });

  // Lifecycle hooks can mutate owner state. The command supplies an authority
  // check while retaining responsibility for the later config commit.
  if (plugin.lifecycle?.onAccountConfigChanged) {
    await params.beforePersistentEffect?.();
    await plugin.lifecycle.onAccountConfigChanged({
      prevCfg: params.cfg,
      nextCfg: nextConfig,
      accountId,
      runtime: params.runtime,
    });
  }

  return {
    nextConfig,
    accountId,
    input,
    ...(setup.afterAccountConfigWritten
      ? { afterAccountConfigWritten: setup.afterAccountConfigWritten }
      : {}),
  };
}

type ChannelAccountRemovalAction = "delete" | "disable";

type PreparedChannelAccountRemoval = {
  plugin: ChannelAccountMutationPlugin;
  action: ChannelAccountRemovalAction;
  accountId: string;
  accountKey: string;
  shouldStopRuntime: boolean;
};

type ChannelAccountRemovalError = {
  kind: "unsupported-action" | "nothing-to-remove";
  action: ChannelAccountRemovalAction;
};

function writesSameConfig(a: OpenClawConfig, b: OpenClawConfig): boolean {
  // Section transforms prune by leaving `undefined` members behind, which the config
  // writer drops. Compare what would be written, not the in-memory objects.
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- structuredClone keeps the pruned `undefined` members this must drop.
  const written = (cfg: OpenClawConfig): unknown => JSON.parse(JSON.stringify(cfg));
  return isDeepStrictEqual(written(a), written(b));
}

/**
 * True when the channel has no such account to remove.
 *
 * Two signals, both required, because neither is sound alone: the channel must list the
 * account, since a removal transform may take more with it than the account named, and
 * removing it must change the written config, since a listing also reports fallback and
 * owner-discovered ids that own no configuration.
 */
function channelAccountIsAbsent(params: {
  plugin: ChannelAccountMutationPlugin;
  cfg: OpenClawConfig;
  accountId: string;
}): boolean {
  if (!params.plugin.config.listAccountIds(params.cfg).includes(params.accountId)) {
    return true;
  }
  const deleteAccount = params.plugin.config.deleteAccount;
  // A channel that cannot remove an account cannot answer the second question.
  if (!deleteAccount) {
    return false;
  }
  return writesSameConfig(
    deleteAccount({ cfg: { ...params.cfg }, accountId: params.accountId }),
    params.cfg,
  );
}

export function prepareChannelAccountRemoval(params: {
  plugin: ChannelAccountMutationPlugin;
  accountId?: string;
  action: ChannelAccountRemovalAction;
}): PreparedChannelAccountRemoval {
  // normalizeAccountId maps omitted values to the literal default account, so
  // the command's former nullish plugin-default fallback was unreachable.
  const accountId = normalizeAccountId(params.accountId);
  return {
    plugin: params.plugin,
    action: params.action,
    accountId,
    accountKey: accountId || DEFAULT_ACCOUNT_ID,
    shouldStopRuntime: Boolean(
      params.plugin.gateway?.startAccount || params.plugin.gateway?.logoutAccount,
    ),
  };
}

export async function applyPreparedChannelAccountRemoval(params: {
  cfg: OpenClawConfig;
  prepared: PreparedChannelAccountRemoval;
  runtime: RuntimeEnv;
}): Promise<Result<{ nextConfig: OpenClawConfig }, ChannelAccountRemovalError>> {
  const { accountId, action, plugin } = params.prepared;
  // Capability validation stays in apply: callers must preserve the historical
  // runtime-stop ordering before reporting an unsupported mutation.
  if (action === "delete") {
    if (!plugin.config.deleteAccount) {
      return resultError({ kind: "unsupported-action", action });
    }
    const nextConfig = plugin.config.deleteAccount({
      cfg: { ...params.cfg },
      accountId,
    });
    // Removal maps any id onto a config key, so deleting an account the channel does not
    // have leaves the config untouched. Report that instead of running the removal
    // lifecycle and persisting an unchanged config as a completed deletion. The result is
    // already computed here, so this repeats channelAccountIsAbsent without re-running the
    // transform.
    if (
      !plugin.config.listAccountIds(params.cfg).includes(accountId) ||
      writesSameConfig(nextConfig, params.cfg)
    ) {
      return resultError({ kind: "nothing-to-remove", action });
    }
    await plugin.lifecycle?.onAccountRemoved?.({
      prevCfg: params.cfg,
      accountId,
      runtime: params.runtime,
    });
    return ok({ nextConfig });
  }

  if (!plugin.config.setAccountEnabled) {
    return resultError({ kind: "unsupported-action", action });
  }
  // Disabling writes the account entry, so an account the channel does not have would be
  // authored here as a brand-new disabled one and reported as the account the operator
  // meant to stop.
  if (channelAccountIsAbsent({ plugin, cfg: params.cfg, accountId })) {
    return resultError({ kind: "nothing-to-remove", action });
  }
  const nextConfig = plugin.config.setAccountEnabled({
    cfg: { ...params.cfg },
    accountId,
    enabled: false,
  });
  await plugin.lifecycle?.onAccountConfigChanged?.({
    prevCfg: params.cfg,
    nextCfg: nextConfig,
    accountId,
    runtime: params.runtime,
  });
  return ok({ nextConfig });
}
