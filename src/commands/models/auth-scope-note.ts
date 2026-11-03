import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import type { WizardPrompter } from "../../wizard/prompts.js";

/** Keep the CLI scope note for detected or configured shared use. */
export async function isSharedGatewayForCliLogin(config: OpenClawConfig): Promise<boolean> {
  const gateway = config.gateway;
  if (
    // Local state cannot describe the people on a remote Gateway.
    gateway?.mode === "remote" ||
    gateway?.auth?.mode === "trusted-proxy" ||
    gateway?.roles ||
    Object.keys(gateway?.auth?.identityScopes ?? {}).length > 0
  ) {
    return true;
  }
  try {
    const catalog = await prepareUserProfileCatalog();
    try {
      return catalog.hasMultipleSessionSharingIdentities();
    } finally {
      catalog.release();
    }
  } catch {
    // Unreadable state must not block sign-in or hide guidance that may apply.
    return true;
  }
}

export async function showModelsAuthScopeNote(prompter: WizardPrompter, agentId: string) {
  await prompter.note(
    [
      "Scope: System / agent",
      `Agent: ${agentId}`,
      "Location: the machine running OpenClaw",
      `For personal model accounts on a Gateway, run ${formatCliCommand("openclaw models accounts login --help")}.`,
    ].join("\n"),
    "Provider sign-in",
  );
}
