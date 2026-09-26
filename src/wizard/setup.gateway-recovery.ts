/** Projects onboarding service outcomes into operator recovery instructions. */
import { formatCliCommand } from "../cli/command-format.js";
import {
  formatExternalSupervisorActionRequired,
  resolveExternalSupervisorGuidance,
} from "../infra/gateway-supervision.js";
import { t } from "./i18n/index.js";

export type GatewayServiceSetupOutcome =
  | {
      status: "ready";
      action: "installed" | "started" | "reused" | "restarted" | "restart-scheduled";
    }
  | { status: "skipped"; reason: "explicit" | "systemd-unavailable" | "external" }
  | { status: "failed"; error: string };

export function buildGatewayRecoveryProjection(params: {
  gateway: GatewayServiceSetupOutcome;
  reachable: boolean;
  serviceLabel?: string;
}): {
  detail: string;
  summary: string;
} {
  const { gateway } = params;
  const notDetected = t("wizard.finalize.gatewayNotDetected");
  if (params.reachable && gateway.status !== "failed") {
    return { detail: t("wizard.finalize.gatewayReachable"), summary: t("wizard.guided.complete") };
  }
  if (gateway.status === "ready") {
    const service = params.serviceLabel ?? t("wizard.finalize.gatewayService");
    const detail = t("wizard.finalize.managedGatewayUnreachable", {
      service,
      statusCommand: formatCliCommand("openclaw gateway status --deep"),
      recoveryCommand: formatCliCommand("openclaw gateway restart"),
    });
    return { detail, summary: `${notDetected} ${detail.replaceAll("\n", " ")}` };
  }
  if (gateway.status === "failed") {
    const service = params.serviceLabel ?? t("wizard.finalize.gatewayService");
    const detail = t("wizard.finalize.managedGatewaySetupFailed", {
      service,
      error: gateway.error,
      statusCommand: formatCliCommand("openclaw gateway status --deep"),
      recoveryCommand: formatCliCommand("openclaw gateway install --force"),
    });
    return {
      detail,
      summary: `${params.reachable ? "" : `${notDetected} `}${detail.replaceAll("\n", " ")}`,
    };
  }

  const startGuidance =
    gateway.reason === "external"
      ? formatExternalSupervisorActionRequired(
          "start the gateway",
          resolveExternalSupervisorGuidance("start"),
        )
      : t("wizard.finalize.startGatewayNow", {
          command: formatCliCommand("openclaw gateway run"),
        });
  const summary = [notDetected, startGuidance].join(" ");
  if (gateway.reason === "external") {
    return { detail: [notDetected, startGuidance].join("\n"), summary };
  }
  return {
    detail: [
      notDetected,
      t("wizard.finalize.noBackgroundGatewayExpected"),
      startGuidance,
      t("wizard.finalize.rerunInstallDaemon", {
        command: formatCliCommand("openclaw onboard --install-daemon"),
      }),
      t("wizard.finalize.skipHealthNextTime", {
        command: formatCliCommand("openclaw onboard --skip-health"),
      }),
    ].join("\n"),
    summary,
  };
}
