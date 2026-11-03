import type { BoardGetParams } from "@openclaw/gateway-protocol";
import type {
  ControlUiActionV2 as ControlUiAction,
  ControlUiSession,
} from "../../../src/plugin-sdk/control-ui.js";
import type { PluginSessionMenuAction } from "../components/session-menu-solid.tsx";
import type { ControlUiPluginCapability } from "./control-ui-capability.ts";

export function pluginSessionMenuActions(
  runtime: ControlUiPluginCapability,
  session: ControlUiSession,
): PluginSessionMenuAction[] {
  return runtime
    .registrations("actions")
    .filter((entry) => entry.value.placement === "session")
    .flatMap((entry) => {
      try {
        const state = entry.value.resolve?.({
          sessionKey: session.key,
          agentId: session.agentId,
          session: structuredClone(session),
        });
        return state?.hidden
          ? []
          : [
              {
                id: entry.key,
                label: state?.label ?? entry.value.label,
                disabled: state?.disabled,
                icon: entry.value.icon,
                shortcut: entry.value.shortcut,
                opensExternal: entry.value.opensExternal,
              },
            ];
      } catch (error) {
        runtime.reportError(entry.pluginId, error);
        return [];
      }
    });
}

export async function runControlUiPluginAction(
  params: BoardGetParams & {
    runtime: ControlUiPluginCapability;
    id: string;
    placement: ControlUiAction["placement"];
    session?: ControlUiSession;
    signal: AbortSignal;
    isCurrent?: () => boolean;
  },
): Promise<void> {
  const retry =
    params.placement === "session"
      ? "Reopen the session menu."
      : "Try again from the current view.";
  if (params.placement === "session" && !params.session) {
    throw new Error(`This session is no longer available. ${retry}`);
  }
  const entry = params.runtime
    .registrations("actions")
    .find(
      (candidate) => candidate.key === params.id && candidate.value.placement === params.placement,
    );
  if (!entry) {
    throw new Error(`This plugin action is no longer active. ${retry}`);
  }
  return entry.host.invokeAction(entry.value, entry.signal, params, retry);
}
