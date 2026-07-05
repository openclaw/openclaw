// Reads service manager state for status reports.
// Converts gateway/node launchd/systemd state into a compact summary shape.

<<<<<<< HEAD
import { OPENCLAW_WRAPPER_ENV_KEY } from "../daemon/program-args.js";
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import {
  summarizeGatewayServiceLayout,
  type GatewayServiceLayoutSummary,
} from "../daemon/service-layout.js";
import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
<<<<<<< HEAD
import type { GatewayServiceCommandConfig } from "../daemon/service-types.js";
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import { readGatewayServiceState, type GatewayService } from "../daemon/service.js";

type ServiceStatusSummary = {
  label: string;
  installed: boolean | null;
  loaded: boolean;
  managedByOpenClaw: boolean;
  externallyManaged: boolean;
  loadedText: string;
  runtime: GatewayServiceRuntime | undefined;
  layout?: GatewayServiceLayoutSummary;
<<<<<<< HEAD
  wrapperPath?: string;
};

function normalizeServiceWrapperPath(
  command: GatewayServiceCommandConfig | null,
): string | undefined {
  const wrapperPath = command?.environment?.[OPENCLAW_WRAPPER_ENV_KEY]?.trim();
  return wrapperPath || undefined;
}

=======
};

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
/** Reads a daemon service summary, falling back to unknown when service inspection fails. */
export async function readServiceStatusSummary(
  service: GatewayService,
  fallbackLabel: string,
): Promise<ServiceStatusSummary> {
  try {
    const state = await readGatewayServiceState(service, { env: process.env });
    const layout = await summarizeGatewayServiceLayout(state.command);
<<<<<<< HEAD
    const wrapperPath = normalizeServiceWrapperPath(state.command);
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    const managedByOpenClaw = state.installed;
    // A running unmanaged process still counts as installed for status display.
    const externallyManaged = !managedByOpenClaw && state.running;
    const installed = managedByOpenClaw || externallyManaged;
    const loadedText = externallyManaged
      ? "running (externally managed)"
      : state.loaded
        ? service.loadedText
        : service.notLoadedText;
    return {
      label: service.label,
      installed,
      loaded: state.loaded,
      managedByOpenClaw,
      externallyManaged,
      loadedText,
      runtime: state.runtime,
      ...(layout ? { layout } : {}),
<<<<<<< HEAD
      ...(wrapperPath ? { wrapperPath } : {}),
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    };
  } catch {
    // Status output should survive service-manager errors and show an unknown row.
    return {
      label: fallbackLabel,
      installed: null,
      loaded: false,
      managedByOpenClaw: false,
      externallyManaged: false,
      loadedText: "unknown",
      runtime: undefined,
    };
  }
}
