import type { GatewayServiceControlArgs } from "../../daemon/service-types.js";
import {
  readGatewayServiceState,
  resolveGatewayService,
  type GatewayService,
} from "../../daemon/service.js";
import { recoverInstalledLaunchAgent } from "../daemon-cli/launchd-recovery.js";

export type PostUpdateLaunchAgentRecoveryResult =
  | { status: "not-needed" }
  | { status: "recovered"; message: string }
  | { status: "failed" | "inspection-failed"; detail: string };

export async function recoverInstalledLaunchAgentAfterUpdate(params: {
  service?: GatewayService;
  deadline?: GatewayServiceControlArgs["deadline"];
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
  onGatewayStartAttempted?: () => void;
}): Promise<PostUpdateLaunchAgentRecoveryResult> {
  params.assertCurrent?.();
  if (process.platform !== "darwin") {
    return { status: "not-needed" };
  }

  const service = params.service ?? resolveGatewayService();
  const state = await readGatewayServiceState(service, {
    env: params.env,
    timeoutMs: params.deadline?.remainingMs(),
  }).catch((error: unknown) => ({ error }));
  params.assertCurrent?.();
  const inspectionFailed = (error: unknown): PostUpdateLaunchAgentRecoveryResult => ({
    status: "inspection-failed",
    detail: `LaunchAgent state could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
  });
  if ("error" in state) {
    return inspectionFailed(state.error);
  }
  if (state.loadState.status === "unknown") {
    return inspectionFailed(state.loadState.detail);
  }
  if (state.loadState.status !== "not-loaded" || !state.installed) {
    return { status: "not-needed" };
  }

  let recovered: Awaited<ReturnType<typeof recoverInstalledLaunchAgent>>;
  try {
    params.onGatewayStartAttempted?.();
    recovered = await recoverInstalledLaunchAgent({
      result: "restarted",
      env: state.env,
      deadline: params.deadline,
    });
    params.assertCurrent?.();
  } catch (error) {
    params.assertCurrent?.();
    return {
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!recovered) {
    return {
      status: "failed",
      detail:
        "LaunchAgent was installed but not loaded; automatic bootstrap/kickstart recovery failed.",
    };
  }

  return {
    status: "recovered",
    message: recovered.message,
  };
}
