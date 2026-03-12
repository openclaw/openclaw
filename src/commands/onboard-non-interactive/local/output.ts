import type { RuntimeEnv } from "../../../runtime.js";
import type { RescueWatchdogSetupResult } from "../../onboard-rescue.js";
import type { OnboardOptions } from "../../onboard-types.js";

export function logNonInteractiveOnboardingJson(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  mode: "local" | "remote";
  workspaceDir?: string;
  authChoice?: string;
  gateway?: {
    port: number;
    bind: string;
    authMode: string;
    tailscaleMode: string;
  };
  installDaemon?: boolean;
  daemonRuntime?: string;
  rescueWatchdog?: RescueWatchdogSetupResult;
  skipSkills?: boolean;
  skipHealth?: boolean;
}) {
  if (!params.opts.json) {
    return;
  }
  params.runtime.log(
    JSON.stringify(
      {
        mode: params.mode,
        workspace: params.workspaceDir,
        authChoice: params.authChoice,
        gateway: params.gateway,
        installDaemon: Boolean(params.installDaemon),
        daemonRuntime: params.daemonRuntime,
        rescueWatchdog: params.rescueWatchdog,
        skipSkills: Boolean(params.skipSkills),
        skipHealth: Boolean(params.skipHealth),
      },
      null,
      2,
    ),
  );
}
