// `openclaw plugins enable/disable` policy path. Kept out of plugins-cli.runtime.ts so the
// grandfathered runtime module does not grow past its line-cap ratchet.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { assertConfigWriteAllowedInCurrentMode } from "../config/config.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { defaultRuntime } from "../runtime.js";
import { formatMissingPluginMessage } from "./error-format.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import { runWithLocalPluginState } from "./plugins-local-state.js";

async function applyPluginEnabledThroughGateway(
  pluginId: string,
  enabled: boolean,
  opts: { acceptCapabilities?: boolean } = {},
): Promise<boolean> {
  const { resolvePluginLifecycleGateway } = await import("./plugins-lifecycle-client.js");
  const gateway = await resolvePluginLifecycleGateway();
  if (!gateway) {
    return false;
  }
  const consent = resolvePluginCapabilityConsentCliOptions({ ...opts, action: "enable" });
  const result = await gateway<{ plugin: { id: string }; warnings?: string[] }>(
    "plugins.setEnabled",
    { pluginId, enabled, ...(enabled ? { allowlistPolicy: "preserve" } : {}) },
    consent.onCapabilityConsent,
  );
  // Plugin ids and lifecycle warnings are config-derived; keep human lines from controlling the terminal.
  for (const warning of result.warnings ?? []) {
    defaultRuntime.log(theme.warn(sanitizeTerminalText(warning)));
  }
  defaultRuntime.log(
    `${enabled ? "Enabled" : "Disabled"} plugin "${sanitizeTerminalText(result.plugin.id)}".`,
  );
  return true;
}

export async function runPluginsEnableCommand(
  id: string,
  opts: { acceptCapabilities?: boolean } = {},
): Promise<void> {
  await runPluginPolicyCommand(id, true, opts.acceptCapabilities);
}

export async function runPluginsDisableCommand(id: string): Promise<void> {
  await runPluginPolicyCommand(id, false);
}

async function runPluginPolicyCommand(
  id: string,
  enabled: boolean,
  acceptCapabilities?: boolean,
): Promise<void> {
  assertConfigWriteAllowedInCurrentMode();
  if (await applyPluginEnabledThroughGateway(id, enabled, { acceptCapabilities })) {
    return;
  }
  return await runWithLocalPluginState(enabled ? "enable" : "disable", async (assertCurrent) => {
    const { mutateManagedPluginEnabled } = await import("../plugins/management-mutations.js");
    const { ManagedPluginLifecycleError } =
      await import("../plugins/management-lifecycle-error.js");
    await withPluginLifecycleLease({}, async () => {
      try {
        const result = await mutateManagedPluginEnabled({
          pluginId: id,
          enabled,
          caller: "cli",
          beforePersistentApply: assertCurrent,
          requestCapabilityConsent: acceptCapabilities,
          ...resolvePluginCapabilityConsentCliOptions({ acceptCapabilities, action: "enable" }),
        });
        if (result.status === "missing") {
          const message = formatMissingPluginMessage({
            id: sanitizeTerminalText(result.pluginId),
            includeSearch: true,
          });
          defaultRuntime.error(message);
          return defaultRuntime.exit(1);
        }
        if (result.status === "blocked") {
          defaultRuntime.error(
            `Plugin "${sanitizeTerminalText(result.pluginId)}" could not be enabled (${sanitizeTerminalText(result.reason ?? "unknown reason")}).`,
          );
          return defaultRuntime.exit(1);
        }
        for (const warning of result.warnings) {
          defaultRuntime.log(theme.warn(sanitizeTerminalText(warning)));
        }
        defaultRuntime.log(
          `${enabled ? "Enabled" : "Disabled"} plugin "${sanitizeTerminalText(result.pluginId)}". Saved for the next Gateway start.`,
        );
      } catch (error) {
        if (!(error instanceof ManagedPluginLifecycleError) || !error.capabilityConsent) {
          throw error;
        }
        defaultRuntime.error(error.message);
        return defaultRuntime.exit(1);
      }
    });
  });
}
