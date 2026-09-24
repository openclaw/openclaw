import type {
  PortalCloseResult,
  PortalListResult,
  PortalSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import { WRITE_SCOPE } from "../../gateway/operator-scopes.js";
import type { AgentToolResult } from "../runtime/index.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";
import {
  callAgentToolGatewayRequest,
  callInProcessGatewayTool,
  type AgentToolGatewayRequestCaller,
  type InProcessGatewayCaller,
} from "./in-process-gateway.js";
import {
  PORTAL_TOOL_DESCRIPTION,
  SESSION_PORTAL_TOOL_DESCRIPTION,
  PortalOutputSchema,
  PortalToolSchema,
  SessionPortalToolSchema,
} from "./portal-tool-contract.js";
import type { SessionPortalToolTarget } from "./session-portal-target.js";

// Reading a portal's bearer URL is a write-scope capability: it is the same
// credential action=open mints, so listing must ask for it explicitly.
const PORTAL_URL_SCOPE = WRITE_SCOPE;

type PortalToolOptions = {
  callGateway?: InProcessGatewayCaller;
  callGatewayRequest?: AgentToolGatewayRequestCaller;
};

export function createAvailablePortalTools(
  options: PortalToolOptions & {
    sessionPortalTarget?: SessionPortalToolTarget;
    senderIsOwner?: boolean;
  } = {},
): AnyAgentTool[] {
  return options.senderIsOwner === false && !options.sessionPortalTarget
    ? []
    : [portalTool(options, options.sessionPortalTarget)];
}

type PortalToolOutcome =
  | { action: "open"; result: PortalSummary }
  | { action: "list"; result: PortalListResult }
  | { action: "close"; id: string; result: PortalCloseResult };

export function formatPortalResult(
  outcome: PortalToolOutcome,
): AgentToolResult<PortalSummary | PortalListResult | PortalCloseResult> {
  const text =
    outcome.action === "open"
      ? `Portal route allocated at ${outcome.result.url}. Pass PUBLIC_URL=${outcome.result.publicUrl} and PORT=${outcome.result.port} when starting the dev server. Open it in the Control UI Portals page to verify browser access and application rendering; allocation does not prove either. Remote access requires private portal ingress or a reachable direct listener.`
      : outcome.action === "list"
        ? `${outcome.result.portals.length} active portal${outcome.result.portals.length === 1 ? "" : "s"}. The operator can see them in the Control UI Portals page.`
        : `Portal ${outcome.id} closed. The Control UI Portals page has been updated.`;
  const result = jsonResult(outcome.result);
  return { ...result, content: [{ type: "text", text }, ...result.content] };
}

function portalTool(options: PortalToolOptions, target?: SessionPortalToolTarget): AnyAgentTool {
  const callGateway = options.callGateway ?? callInProcessGatewayTool;
  const callGatewayRequest = options.callGatewayRequest ?? callAgentToolGatewayRequest;
  return {
    label: "Portal",
    name: "portal",
    description: target ? SESSION_PORTAL_TOOL_DESCRIPTION : PORTAL_TOOL_DESCRIPTION,
    parameters: target ? SessionPortalToolSchema : PortalToolSchema,
    outputSchema: PortalOutputSchema,
    execute: async (_toolCallId, rawArgs) => {
      const params = rawArgs as Record<string, unknown>;
      target?.assertCurrent();
      const action = readToolStringParam(params, "action", { required: true });
      const environmentId = readToolStringParam(params, "environmentId");
      if (target && environmentId !== undefined) {
        throw new ToolInputError("This portal tool is bound to the conversation's attached worker");
      }
      const environment = target
        ? {
            sessionKey: target.sessionKey,
            agentId: target.agentId,
            environmentId: target.environmentId,
          }
        : environmentId
          ? { environmentId }
          : {};
      if (action === "list") {
        if (target) {
          const result = await callGateway<PortalListResult>("portal.session.list", environment);
          target.assertCurrent();
          return formatPortalResult({ action: "list", result });
        }
        // portal.list redacts the bearer URL for read-scope callers. Least-privilege
        // resolution would make every list call read-scope, hiding the URL from a
        // caller that can mint the same portal through action=open; ask with the
        // write authority this tool already requires so the listing stays usable.
        const result = await callGatewayRequest<PortalListResult>({
          method: "portal.list",
          params: environment,
          scopes: [PORTAL_URL_SCOPE],
        });
        return formatPortalResult({ action: "list", result });
      }
      if (action === "close") {
        const id = readToolStringParam(params, "id", { required: true });
        const result = await callGateway<PortalCloseResult>(
          target ? "portal.session.close" : "portal.close",
          { id, ...environment },
        );
        target?.assertCurrent();
        return formatPortalResult({ action: "close", id, result });
      }
      if (action !== "open") {
        throw new ToolInputError(`Unknown portal action: ${action}`);
      }
      const port = readPositiveIntegerParam(params, "port", {
        max: 65_535,
        message: "port must be an integer from 1 to 65535",
      });
      if (port === undefined) {
        throw new ToolInputError("port required");
      }
      const title = readToolStringParam(params, "title");
      const description = readToolStringParam(params, "description", { allowEmpty: true });
      const path = readToolStringParam(params, "path");
      if (path !== undefined && !path.startsWith("/")) {
        throw new ToolInputError("path must start with /");
      }
      const portal = await callGateway<PortalSummary>(
        target ? "portal.session.open" : "portal.open",
        {
          ...environment,
          port,
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(path !== undefined ? { path } : {}),
        },
      );
      target?.assertCurrent();
      return formatPortalResult({ action: "open", result: portal });
    },
  };
}
