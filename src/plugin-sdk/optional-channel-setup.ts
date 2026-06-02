import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import type { ChannelSetupWizard } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

type OptionalChannelSetupParams = {
  /** Channel id used by setup discovery and wizard status output. */
  channel: string;
  /** Human-readable plugin label shown in install guidance. */
  label: string;
  /** Optional package spec to show instead of the generic plugin label. */
  npmSpec?: string;
  /** Public docs path appended to docs.openclaw.ai when install guidance should link out. */
  docsPath?: string;
};

function buildOptionalChannelSetupMessage(params: OptionalChannelSetupParams): string {
  const installTarget = params.npmSpec ?? `the ${params.label} plugin`;
  const message = [`${params.label} setup requires ${installTarget} to be installed.`];
  if (params.docsPath) {
    message.push(`Docs: ${formatDocsLink(params.docsPath, params.docsPath.replace(/^\/+/u, ""))}`);
  }
  return message.join(" ");
}

export function createOptionalChannelSetupAdapter(
  params: OptionalChannelSetupParams,
): ChannelSetupAdapter {
  const message = buildOptionalChannelSetupMessage(params);
  return {
    // Optional plugins cannot mutate config from core; the adapter only preserves account routing
    // and returns the install message until the real plugin-owned setup adapter is present.
    resolveAccountId: ({ accountId }) => accountId ?? DEFAULT_ACCOUNT_ID,
    applyAccountConfig: () => {
      throw new Error(message);
    },
    validateInput: () => message,
  };
}

export function createOptionalChannelSetupWizard(
  params: OptionalChannelSetupParams,
): ChannelSetupWizard {
  const message = buildOptionalChannelSetupMessage(params);
  return {
    channel: params.channel,
    status: {
      configuredLabel: `${params.label} plugin installed`,
      unconfiguredLabel: `install ${params.label} plugin`,
      configuredHint: message,
      unconfiguredHint: message,
      unconfiguredScore: 0,
      resolveConfigured: () => false,
      resolveStatusLines: () => [message],
      resolveSelectionHint: () => message,
    },
    credentials: [],
    // Discovery can list this wizard, but finalization must fail loudly so core never pretends an
    // uninstalled optional plugin has completed setup.
    finalize: async () => {
      throw new Error(message);
    },
  };
}
