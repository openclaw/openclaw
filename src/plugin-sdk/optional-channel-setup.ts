import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import type { ChannelSetupWizard } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

type OptionalChannelSetupParams = {
  /** Channel id used by setup wizard status and routing. */
  channel: string;
  /** Human-readable plugin label shown in operator-facing install guidance. */
  label: string;
  /** Package spec operators should install before running real channel setup. */
  npmSpec?: string;
  /** Docs path linked from validation and wizard status messages. */
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
  /** Optional plugin metadata used to build setup validation guidance. */
  params: OptionalChannelSetupParams,
): ChannelSetupAdapter {
  const message = buildOptionalChannelSetupMessage(params);
  return {
    resolveAccountId: ({ accountId }) => accountId ?? DEFAULT_ACCOUNT_ID,
    applyAccountConfig: () => {
      throw new Error(message);
    },
    validateInput: () => message,
  };
}

export function createOptionalChannelSetupWizard(
  /** Optional plugin metadata used to build setup wizard status guidance. */
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
    finalize: async () => {
      throw new Error(message);
    },
  };
}
