import { readGatewayServiceLoadState } from "../../daemon/service-load-state.js";
import type { GatewayService } from "../../daemon/service.js";
import { renderSystemdUnavailableHints } from "../../daemon/systemd-hints.js";
import { isSystemdUserServiceAvailable } from "../../daemon/systemd.js";
import { isWSL } from "../../infra/wsl.js";
import type { createDaemonActionContext } from "./response.js";
import { filterContainerGenericHints } from "./shared.js";

export type ServiceTarget = {
  serviceNoun: string;
  service: GatewayService;
};

export async function failServiceNotLoaded(
  params: ServiceTarget & { renderStartHints: () => string[] },
  fail: ReturnType<typeof createDaemonActionContext>["fail"],
) {
  let hints = params.renderStartHints();
  if (process.platform === "linux" && !(await isSystemdUserServiceAvailable().catch(() => false))) {
    hints = [
      ...hints,
      ...renderSystemdUnavailableHints({ wsl: await isWSL(), kind: "generic_unavailable" }),
    ];
  }
  fail(
    `${params.serviceNoun} service ${params.service.notLoadedText}.`,
    filterContainerGenericHints(hints),
  );
}

export async function resolveServiceLoadedOrFail(
  params: ServiceTarget,
  fail: ReturnType<typeof createDaemonActionContext>["fail"],
  opts: { acceptInstalledDefinition?: boolean; inspectionFailureMessage?: string } = {},
): Promise<boolean | null> {
  // Keep native scope discovery in the adapter and failure emission in the action context.
  const hasInstalledDefinition = async () =>
    params.service.hasInstalledDefinition
      ? await params.service.hasInstalledDefinition({ env: process.env }).catch(() => false)
      : Boolean(await params.service.readCommand(process.env).catch(() => null));
  const loadState = await readGatewayServiceLoadState(params.service, { env: process.env });
  if (loadState.status === "unknown") {
    fail(
      `${opts.inspectionFailureMessage ?? `${params.serviceNoun} service check failed`}: ${loadState.detail}`,
    );
    return null;
  }
  return (
    loadState.status === "loaded" ||
    (Boolean(opts.acceptInstalledDefinition) && (await hasInstalledDefinition()))
  );
}
