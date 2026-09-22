import { Type } from "typebox";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { UiCommand, UiCommandParams } from "../../../packages/gateway-protocol/src/index.js";
// The tool returns the Gateway result unchanged, so the wire schema remains the single owner.
import { UiCommandResultSchema } from "../../../packages/gateway-protocol/src/schema/ui-command.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readToolStringParam, ToolInputError } from "./common.js";
import { callInProcessGatewayTool, type InProcessGatewayCaller } from "./in-process-gateway.js";

const ACTIONS = [
  "split_right",
  "split_down",
  "close_pane",
  "focus",
  "sidebar_show",
  "sidebar_hide",
  "terminal_show",
  "terminal_hide",
  "browser_show",
  "browser_hide",
  "desktop_show",
  "desktop_hide",
  "portal_show",
  "portal_hide",
  "navigate",
] as const;

const ScreenToolSchema = Type.Object(
  {
    action: Type.String({ enum: [...ACTIONS], description: "Action" }),
    sessionKey: Type.Optional(Type.String({ description: "Session. Default: current" })),
    environmentId: Type.Optional(
      Type.String({ description: "Desktop source, or a pending portal's environment ID" }),
    ),
    portalId: Type.Optional(Type.String({ description: "Portal ID returned by portal open/list" })),
    dock: Type.Optional(
      Type.String({ enum: ["bottom", "right"], description: "Panel dock on show" }),
    ),
  },
  { additionalProperties: false },
);

type ScreenToolOptions = {
  agentSessionKey?: string;
  agentId?: string;
  callGateway?: InProcessGatewayCaller;
};

function resolveSessionKey(
  params: Record<string, unknown>,
  agentSessionKey: string | undefined,
): string {
  const sessionKey = readToolStringParam(params, "sessionKey") ?? agentSessionKey?.trim();
  if (!sessionKey) {
    throw new ToolInputError("sessionKey required");
  }
  return sessionKey === "current" && agentSessionKey?.trim() ? agentSessionKey.trim() : sessionKey;
}

function readDock(params: Record<string, unknown>): "bottom" | "right" | undefined {
  const dock = readToolStringParam(params, "dock");
  if (dock === undefined || dock === "bottom" || dock === "right") {
    return dock;
  }
  throw new ToolInputError("dock must be bottom or right");
}

function commandForAction(
  action: string,
  params: Record<string, unknown>,
  agentSessionKey: string | undefined,
): UiCommand {
  if (action === "split_right" || action === "split_down") {
    return {
      kind: "split",
      direction: action === "split_right" ? "right" : "down",
      sessionKey: resolveSessionKey(params, agentSessionKey),
    };
  }
  if (action === "close_pane" || action === "focus" || action === "navigate") {
    return {
      kind: action === "close_pane" ? "close-pane" : action,
      sessionKey: resolveSessionKey(params, agentSessionKey),
    };
  }
  if (action === "sidebar_show" || action === "sidebar_hide") {
    return { kind: "sidebar", visible: action === "sidebar_show" };
  }
  if (
    action === "terminal_show" ||
    action === "terminal_hide" ||
    action === "browser_show" ||
    action === "browser_hide" ||
    action === "desktop_show" ||
    action === "desktop_hide" ||
    action === "portal_show" ||
    action === "portal_hide"
  ) {
    const open = action.endsWith("_show");
    const dock = open ? readDock(params) : undefined;
    if (action.startsWith("desktop_") || action.startsWith("portal_")) {
      const environmentId = readToolStringParam(params, "environmentId");
      const target = readToolStringParam(
        params,
        action.startsWith("desktop_") ? "environmentId" : "portalId",
      );
      if (action.startsWith("portal_") && target && environmentId) {
        throw new ToolInputError("Choose portalId or a pending environmentId, not both");
      }
      return {
        kind: "panel",
        open,
        ...(open ? { dock: dock ?? "right" } : {}),
        ...(action.startsWith("desktop_")
          ? { panel: "desktop", ...(target ? { environmentId: target } : {}) }
          : {
              panel: "portal",
              ...(target ? { portalId: target } : environmentId ? { environmentId } : {}),
            }),
      };
    }
    return {
      kind: "panel",
      panel: action.startsWith("terminal_") ? "terminal" : "browser",
      open,
      ...(dock ? { dock } : {}),
    };
  }
  throw new ToolInputError(`Unknown action: ${action}`);
}

export function createScreenTool(opts: ScreenToolOptions = {}): AnyAgentTool {
  const gatewayCall = opts.callGateway ?? callInProcessGatewayTool;
  return {
    label: "Screen",
    name: "screen",
    description:
      "Drive the requesting user's Control UI. desktop_show opens a native app's remote desktop using environmentId; portal_show opens a running web app's portal using portalId. Both default to the right chat sidebar. desktop_hide/portal_hide hide the view without stopping the app. browser_show/browser_hide toggle the agent Browser panel; terminal_show/terminal_hide toggle Terminal; sidebar_show/sidebar_hide toggle the session list. Also supports split_right/split_down, close_pane, focus, navigate. Optional sessionKey selects the conversation; default current. Only the browser that requested this turn is changed; it must still be connected. This changes presentation only; it does not control application input.",
    parameters: ScreenToolSchema,
    outputSchema: UiCommandResultSchema,
    requiredClientCaps: [GATEWAY_CLIENT_CAPS.UI_COMMANDS],
    execute: async (_toolCallId, rawArgs) => {
      const params = rawArgs as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      const payload: UiCommandParams = {
        command: commandForAction(action, params, opts.agentSessionKey),
        ...(opts.agentSessionKey || readToolStringParam(params, "sessionKey")
          ? { sessionKey: resolveSessionKey(params, opts.agentSessionKey) }
          : {}),
        ...(opts.agentId ? { agentId: opts.agentId } : {}),
      };
      return jsonResult(await gatewayCall("ui.command", payload));
    },
  };
}
