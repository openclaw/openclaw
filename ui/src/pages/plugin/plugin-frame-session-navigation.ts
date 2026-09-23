import { isValidAgentId } from "@openclaw/normalization-core/agent-id";
import {
  buildControlUiSessionPath,
  parseAgentSessionKeyParts,
} from "@openclaw/session-url-contract";
import {
  CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS,
  resolveControlUiPluginTabPathname,
} from "../../../../src/gateway/control-ui-plugin-frame-contract.js";
import type { GatewayControlUiPluginTab } from "../../api/gateway.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import {
  resolveSessionPreferredFaceForKey,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";

/**
 * One-way navigation request from an advertised, authenticated same-origin plugin
 * tab iframe to its parent. Post only these fields with window.parent.postMessage;
 * the host checks the mounted frame and current connection before navigating.
 * sessionKey is a routable session key of at most 512 UTF-16 code units,
 * without surrounding whitespace or control characters; agentId, when present,
 * is a canonical agent-id input matching any owner in sessionKey. No URLs,
 * credentials, session contents, or response channel are accepted or returned.
 * Navigation uses normal session selection and Gateway authorization; it grants
 * no session access.
 */
export type ControlUiPluginSessionOpenMessage = {
  type: "openclaw-plugin-session-open";
  sessionKey: string;
  agentId?: string;
};

function isPluginSessionOpenMessage(value: unknown): value is ControlUiPluginSessionOpenMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (
    "type" in value &&
    value.type === "openclaw-plugin-session-open" &&
    "sessionKey" in value &&
    typeof value.sessionKey === "string" &&
    value.sessionKey.length > 0 &&
    value.sessionKey.length <= 512 &&
    value.sessionKey.trim() === value.sessionKey &&
    !/[\p{Cc}\p{Cs}]/u.test(value.sessionKey) &&
    !/^(?:[a-z][a-z\d+.-]*:)?\/\//iu.test(value.sessionKey) &&
    (!("agentId" in value) ||
      (typeof value.agentId === "string" &&
        value.agentId.trim() === value.agentId &&
        isValidAgentId(value.agentId))) &&
    Object.keys(value).every((key) => key === "type" || key === "sessionKey" || key === "agentId")
  );
}

/** The mounting owner certifies its connection epoch; this boundary validates the frame and message. */
export function openPluginFrameSession(
  event: MessageEvent<unknown>,
  host: {
    context: ApplicationContext;
    element: HTMLElement;
    frame: HTMLIFrameElement | null;
    descriptor: GatewayControlUiPluginTab | undefined;
    authenticated: boolean;
    authenticatedAt: number;
  },
) {
  const { context, element, frame, descriptor: info } = host;
  if (
    !frame?.isConnected ||
    !element.contains(frame) ||
    event.source !== frame.contentWindow ||
    (event.origin !== "null" && event.origin !== window.location.origin) ||
    event.ports.length !== 0 ||
    !isPluginSessionOpenMessage(event.data) ||
    !info?.path ||
    info.requiresGatewayAuth !== true ||
    !resolveControlUiPluginTabPathname(info.path) ||
    frame.getAttribute("src") !== info.path ||
    context.gateway.snapshot.phase !== "connected" ||
    !context.gateway.snapshot.client ||
    !context.gateway.snapshot.hello?.auth ||
    !hasOperatorReadAccess(context.gateway.snapshot.hello.auth) ||
    !host.authenticated ||
    Date.now() - host.authenticatedAt >= CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS
  ) {
    return;
  }
  // Only session metadata crosses this boundary. Destination Gateway reads still own access.
  const { sessionKey, agentId } = event.data;
  const sessionAgentId = parseAgentSessionKeyParts(sessionKey)?.agentId;
  if (
    (sessionAgentId &&
      (!isValidAgentId(sessionAgentId) ||
        (agentId && sessionAgentId.toLowerCase() !== agentId.toLowerCase()))) ||
    !buildControlUiSessionPath({
      namespace: "chat",
      sessionKey,
      fallbackAgentId: agentId ?? "main",
      exactKey: true,
    })
  ) {
    return;
  }
  const face = resolveSessionPreferredFaceForKey(context, sessionKey, agentId);
  const target = sessionNavigationTarget({
    context,
    face,
    sessionKey,
    agentId,
    preferenceDerivedFace: true,
    exactKey: true,
  });
  selectApplicationSession({
    selection: context.agentSelection,
    gateway: context.gateway,
    sessionKey,
    agentId,
  });
  context.navigate(face, target.options);
}
