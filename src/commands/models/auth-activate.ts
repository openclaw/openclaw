import { resolveAgentEffectiveModelPrimary } from "../../agents/agent-scope.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import type { RuntimeEnv } from "../../runtime.js";
import { toSavedAuthSetupKind } from "../../system-agent/setup-inference-core.js";
import { activateSetupInference } from "../../system-agent/setup-inference.js";
import { refreshRunningGatewayAuthState } from "./auth-refresh.js";
import { loadValidConfigSnapshotOrThrow, resolveModelsTargetAgent } from "./shared.js";

export async function modelsAuthActivateCommand(
  opts: { profileId: string; agent?: string },
  runtime: RuntimeEnv,
): Promise<void> {
  const { runtimeConfig } = await loadValidConfigSnapshotOrThrow();
  const { agentId } = resolveModelsTargetAgent(runtimeConfig, opts.agent, { kind: "mutation" });
  const result = await activateSetupInference({
    kind: toSavedAuthSetupKind(opts.profileId.trim()),
    agentId,
    surface: "cli",
    activationConfirmed: true,
    runtime,
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
  const refreshed = await refreshRunningGatewayAuthState(agentId, "update", runtime);
  for (const line of result.lines) {
    runtime.log(line);
  }
  let applied = false;
  if (refreshed === "refreshed") {
    try {
      const current = await callGateway<{
        config: OpenClawConfig;
        configRevisionHash: string;
        appliedConfigHash: string | null;
      }>({
        method: "config.get",
        params: {},
        timeoutMs: 3000,
        requireLocalBackendSharedAuth: true,
      });
      applied =
        current.configRevisionHash === current.appliedConfigHash &&
        splitTrailingAuthProfile(resolveAgentEffectiveModelPrimary(current.config, agentId) ?? "")
          .profile === opts.profileId.trim();
    } catch {
      // A lost acknowledgement cannot turn the completed save into a failed save.
    }
  }
  runtime.log(
    applied
      ? `Saved sign-in activated for ${agentId}: ${opts.profileId}`
      : "Sign-in verified and saved. The running connection could not be confirmed. Run `openclaw gateway restart` to apply the saved settings.",
  );
}
