import { expectDefined } from "@openclaw/normalization-core";
/** Config mutation helpers used by chat commands that edit OpenClaw config. */
import type { ChannelAllowlistAdapter } from "../../channels/plugins/types.adapters.js";
import { setConfigValueAtPath, unsetConfigValueAtPath } from "../../config/config-paths.js";
import {
  mutateConfigFileWithRetry,
  transformConfigFileWithRetry,
  validateConfigObjectWithPlugins,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolvePluginCapabilityConsent,
  type PluginCapabilityConsentHandler,
} from "../../plugins/capability-consent.js";
import { setPluginEnabledInConfig } from "../../plugins/toggle-config.js";

export class AutoReplyConfigMutationError extends Error {}

class AutoReplyConfigNoopMutation extends Error {}

function assertValidConfig(next: Record<string, unknown>, action: string): OpenClawConfig {
  const validated = validateConfigObjectWithPlugins(next);
  if (!validated.ok) {
    const issue = expectDefined(validated.issues[0], "issues entry at 0");
    throw new AutoReplyConfigMutationError(
      `Config invalid after ${action} (${issue.path}: ${issue.message}).`,
    );
  }
  // Validation materializes runtime defaults; the mutation must retain source shape.
  return next;
}

/** Applies a source-config path edit; a missing unset path skips the write. */
export async function mutateConfigPath(
  path: string[],
  mutation: { action: "set"; value: unknown } | { action: "unset" },
  assertCurrent?: () => void,
): Promise<boolean> {
  try {
    await mutateConfigFileWithRetry({
      base: "source",
      afterWrite: { mode: "auto" },
      writeOptions: { assertCurrent },
      mutate: (next) => {
        if (mutation.action === "set") {
          setConfigValueAtPath(next, path, mutation.value);
        } else if (!unsetConfigValueAtPath(next, path)) {
          throw new AutoReplyConfigNoopMutation();
        }
        assertValidConfig(next, mutation.action);
      },
    });
    return true;
  } catch (error) {
    if (error instanceof AutoReplyConfigNoopMutation) {
      return false;
    }
    throw error;
  }
}

/** Toggles plugin enablement from a chat command. */
export async function setPluginEnabledFromCommand(params: {
  pluginId: string;
  action: "enable" | "disable";
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  assertCurrent?: () => void;
}): Promise<void> {
  await transformConfigFileWithRetry({
    afterWrite: { mode: "auto" },
    writeOptions: { assertCurrent: params.assertCurrent },
    transform: async (currentConfig) => {
      const enabled = params.action === "enable";
      if (enabled) {
        await resolvePluginCapabilityConsent({
          config: currentConfig,
          pluginId: params.pluginId,
          onCapabilityConsent: params.onCapabilityConsent,
          beforePersistentApply: params.assertCurrent,
        });
      }
      const next = setPluginEnabledInConfig(
        structuredClone(currentConfig),
        params.pluginId,
        enabled,
      );
      return { nextConfig: assertValidConfig(next, `/plugins ${params.action}`) };
    },
  });
}

/** Applies a channel allowlist edit through a plugin-provided config mutation hook. */
export async function applyAllowlistConfigMutation(params: {
  accountId?: string | null;
  scope: "dm" | "group";
  action: "add" | "remove";
  entry: string;
  applyConfigEdit: NonNullable<ChannelAllowlistAdapter["applyConfigEdit"]>;
  assertCurrent?: () => void;
}): Promise<void> {
  await transformConfigFileWithRetry({
    base: "source",
    afterWrite: { mode: "auto" },
    writeOptions: { assertCurrent: params.assertCurrent },
    transform: async (currentConfig) => {
      const latestParsedConfig = structuredClone(currentConfig) as Record<string, unknown>;
      const latestEditResult = await params.applyConfigEdit({
        cfg: currentConfig,
        parsedConfig: latestParsedConfig,
        accountId: params.accountId,
        scope: params.scope,
        action: params.action,
        entry: params.entry,
      });
      if (!latestEditResult || latestEditResult.kind === "invalid-entry") {
        throw new AutoReplyConfigMutationError("Invalid allowlist entry.");
      }
      if (!latestEditResult.changed) {
        return { nextConfig: currentConfig };
      }
      return {
        nextConfig: assertValidConfig(latestParsedConfig, "update"),
      };
    },
  });
}
