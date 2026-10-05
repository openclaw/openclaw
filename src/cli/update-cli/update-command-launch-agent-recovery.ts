import {
  readGatewayServiceState,
  resolveGatewayService,
  type GatewayService,
} from "../../daemon/service.js";
import { recoverInstalledLaunchAgent } from "../daemon-cli/launchd-recovery.js";

export type PostUpdateLaunchAgentRecoveryResult =
  | { attempted: false; recovered: false }
  | { attempted: true; recovered: true; message: string }
  | { attempted: true; recovered: false; detail: string };

export async function recoverInstalledLaunchAgentAfterUpdate(params: {
  service?: GatewayService;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
  onGatewayStartAttempted?: () => void;
}): Promise<PostUpdateLaunchAgentRecoveryResult> {
  params.assertCurrent?.();
  if (process.platform !== "darwin") {
    return { attempted: false, recovered: false };
  }

  const service = params.service ?? resolveGatewayService();
  const state = await readGatewayServiceState(service, { env: params.env }).catch(() => null);
  params.assertCurrent?.();
  if (!state || state.loadState.status !== "not-loaded" || !state.installed) {
    return { attempted: false, recovered: false };
  }

  let recovered: Awaited<ReturnType<typeof recoverInstalledLaunchAgent>>;
  try {
    params.onGatewayStartAttempted?.();
    recovered = await recoverInstalledLaunchAgent({ result: "restarted", env: state.env });
    params.assertCurrent?.();
  } catch (error) {
    params.assertCurrent?.();
    return {
      attempted: true,
      recovered: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!recovered) {
    return {
      attempted: true,
      recovered: false,
      detail:
        "LaunchAgent was installed but not loaded; automatic bootstrap/kickstart recovery failed.",
    };
  }

  return {
    attempted: true,
    recovered: true,
    message: recovered.message,
  };
}
