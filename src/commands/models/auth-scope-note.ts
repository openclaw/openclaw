import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isNamedOperatorRoleEnforcementEnabled } from "../../gateway/operator-role-enforcement.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import type { WizardPrompter } from "../../wizard/prompts.js";

/** Keep the CLI scope note for detected or configured shared use. */
export async function isSharedGatewayForCliLogin(config: OpenClawConfig): Promise<boolean> {
  const gateway = config.gateway;
  if (
    // Local state cannot describe the people on a remote Gateway.
    gateway?.mode === "remote" ||
    gateway?.auth?.mode === "trusted-proxy" ||
    isNamedOperatorRoleEnforcementEnabled(config) ||
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
      // Chat /login and the Control UI show this too, so it names no terminal command.
      "Personal model accounts are managed in Settings → Profile → Connected accounts.",
    ].join("\n"),
    "Provider sign-in",
  );
}
