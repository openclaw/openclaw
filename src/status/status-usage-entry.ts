import { resolveConfiguredModelAuthProfileId } from "../agents/auth-profiles/configured-model-profile.js";
import { resolveCliExecutionAuthProfileId } from "../agents/cli-execution-auth.js";
import { resolveCollapsedSessionAuthPinSource } from "../config/sessions/auth-profile-override-provenance.js";
import { getCliSessionBinding } from "../config/sessions/cli-session-binding.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  CLAUDE_CODE_USAGE_PROVIDER,
  claudeCodeSessionRanOnHostLogin,
} from "../infra/provider-usage.observed.js";
import type { ProviderUsageSnapshot } from "../infra/provider-usage.types.js";

/**
 * Whether a session's next Claude Code turn runs on the Gateway host's own
 * Claude login, the only account whose windows the Claude Code row reports.
 * Usage follows the route the session runs on. The runner's verdict on the
 * session's latest turn covers its environment, arguments, and skills, which
 * /status cannot see; the run's own resolver then covers auth profile changes
 * since, as any profile it would forward, picked or pinned, is another account.
 * A paired node runs under that node's login.
 */
export function sessionRunsOnHostClaudeLogin(params: {
  statusProvider: string;
  authProvider: string;
  modelId: string;
  sessionKey: string;
  sessionEntry?: SessionEntry;
  config: OpenClawConfig;
  agentId: string;
  agentDir: string;
  resolveAuthProfileId?: typeof resolveCliExecutionAuthProfileId;
}): boolean {
  if (
    params.statusProvider !== CLAUDE_CODE_USAGE_PROVIDER ||
    params.sessionEntry?.execHost === "node" ||
    // Backend environment, arguments, and skills can select another account;
    // only the runner sees them, so its verdict on the session's latest turn
    // must admit the session.
    !claudeCodeSessionRanOnHostLogin(params.sessionKey)
  ) {
    return false;
  }
  // The run's selection: a user pin on the session, else the profile the
  // agent's configured model pins, else the session's automatic pick.
  const pinSource = resolveCollapsedSessionAuthPinSource(params.sessionEntry);
  const sessionProfileId = params.sessionEntry?.authProfileOverride?.trim() || undefined;
  const configuredProfileId =
    pinSource === "user" && sessionProfileId
      ? undefined
      : resolveConfiguredModelAuthProfileId({
          cfg: params.config,
          agentId: params.agentId,
          provider: params.authProvider,
          modelId: params.modelId,
        });
  const resolveAuthProfileId = params.resolveAuthProfileId ?? resolveCliExecutionAuthProfileId;
  try {
    return (
      resolveAuthProfileId({
        cliExecutionProvider: CLAUDE_CODE_USAGE_PROVIDER,
        authProfileProvider: params.authProvider,
        config: params.config,
        agentDir: params.agentDir,
        selected: configuredProfileId
          ? { authProfileId: configuredProfileId, authProfileIdSource: "user" }
          : { authProfileId: sessionProfileId, authProfileIdSource: pinSource },
        sessionBinding: getCliSessionBinding(params.sessionEntry, CLAUDE_CODE_USAGE_PROVIDER),
      }) === undefined
    );
  } catch {
    // The run would refuse this pinned profile; it is not the host login.
    return false;
  }
}

/**
 * The provider row for a session that does not run on the host Claude login.
 * The Claude Code row is the host login's windows, so it never stands in for
 * the session's own provider.
 */
export function selectStatusUsageEntry(
  providers: readonly ProviderUsageSnapshot[],
): ProviderUsageSnapshot | undefined {
  return providers.find((entry) => entry.provider !== CLAUDE_CODE_USAGE_PROVIDER);
}
