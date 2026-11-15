import { resolveLaunchAgentLabel } from "../../daemon/launchd-label.js";
import { mergeGatewayServiceEnv } from "../../daemon/service-env-merge.js";
import { assertGatewayServiceUpdateCurrent } from "../../daemon/service-update-authority.js";
import type { GatewayService } from "../../daemon/service.js";
import { resolveSystemdServiceName } from "../../daemon/systemd-service-files.js";
import { GatewayRestartPreparationError } from "../../infra/restart-intent-error.js";
import {
  clearGatewayRestartIntentSync,
  type GatewayRestartIntent,
  type GatewayRestartIntentLegacyProcess,
  type GatewayRestartIntentService,
  prepareGatewayRestartIntentLegacyProcess,
  writeGatewayRestartIntentSync,
  writeGatewayServiceRestartIntentSync,
} from "../../infra/restart-intent.js";

export function createServiceRestartIntent(params: {
  serviceNoun: string;
  service: GatewayService;
  intent?: GatewayRestartIntent;
}) {
  let recorded = false;
  let env = process.env;
  return {
    prepare: async () => {
      if (params.serviceNoun !== "Gateway" || recorded) {
        return;
      }
      const runtime = await params.service.readRuntime(process.env).catch(() => null);
      assertGatewayServiceUpdateCurrent();
      const nativeService = process.platform === "linux" || process.platform === "darwin";
      let service: GatewayRestartIntentService | undefined;
      let legacyProcess: GatewayRestartIntentLegacyProcess | undefined;
      if (nativeService) {
        try {
          const command = await params.service.readCommand(process.env, { requireEffective: true });
          assertGatewayServiceUpdateCurrent();
          if (!command) {
            throw new GatewayRestartPreparationError("service-command");
          }
          env = mergeGatewayServiceEnv(process.env, command);
          service =
            process.platform === "linux"
              ? {
                  kind: "systemd",
                  name: runtime?.systemd?.unit ?? resolveSystemdServiceName(process.env),
                }
              : { kind: "launchd", name: resolveLaunchAgentLabel(process.env) };
          legacyProcess = await prepareGatewayRestartIntentLegacyProcess({
            env,
            command,
            runtimePid: runtime?.pid,
            readRuntime: () => params.service.readRuntime(process.env),
            assertCurrent: assertGatewayServiceUpdateCurrent,
          });
        } catch {
          assertGatewayServiceUpdateCurrent();
          throw new GatewayRestartPreparationError("service-command");
        }
      }
      assertGatewayServiceUpdateCurrent();
      const options = {
        env,
        reason: "gateway.restart",
        ...(params.intent ? { intent: params.intent } : {}),
      };
      recorded = service
        ? writeGatewayServiceRestartIntentSync({
            ...options,
            service,
            legacyProcess,
            nativeStopped: runtime?.status === "stopped" && runtime.pid === undefined,
            assertCurrent: assertGatewayServiceUpdateCurrent,
          })
        : writeGatewayRestartIntentSync({ ...options, targetPid: runtime?.pid });
    },
    clear: () => {
      if (recorded) {
        assertGatewayServiceUpdateCurrent();
        clearGatewayRestartIntentSync(env);
        recorded = false;
      }
    },
  };
}
