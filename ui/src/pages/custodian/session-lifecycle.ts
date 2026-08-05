import {
  readSystemAgentSessionInvalidatedErrorDetails,
  type SystemAgentChatParams,
} from "@openclaw/gateway-protocol";
import { inferBasePathFromPathname, routeIdFromPath } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type {
  ApplicationGatewayConnection,
  ApplicationGatewaySnapshot,
} from "../../app/gateway.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";

export type CustodianSessionVariant = "onboarding" | "new-agent" | "caretaker";
export type CustodianConfiguredInferenceState = "unresolved" | "required" | "ready";

export type CustodianSessionContinuity = {
  key: string;
  ownerKey: string | null;
  authenticatedUserKey: string | null;
  processInstanceId: string | null;
};

function readRecordString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field : null;
}

function resolveCustodianOwner(params: {
  hello: ApplicationGatewaySnapshot["hello"];
  snapshot: ApplicationGatewaySnapshot;
  previous: CustodianSessionContinuity | null;
}): Pick<CustodianSessionContinuity, "ownerKey" | "authenticatedUserKey"> {
  if (!params.hello) {
    return {
      ownerKey: params.previous?.ownerKey ?? null,
      authenticatedUserKey: params.previous?.authenticatedUserKey ?? null,
    };
  }
  const userId = params.snapshot.selfUser?.email?.trim() || params.snapshot.selfUser?.id.trim();
  const deviceId = params.snapshot.client?.authenticatedDeviceId?.trim();
  const userOwner = userId ? `user:${userId}` : null;
  const deviceOwner = deviceId ? `device:${deviceId}` : null;
  const connectionOwner = params.hello.server?.connId
    ? `connection:${params.hello.server.connId}`
    : null;
  const previousOwner = params.previous?.ownerKey ?? null;
  const previousUser = params.previous?.authenticatedUserKey ?? null;
  if (userOwner) {
    if (previousUser && previousUser !== userOwner) {
      return { ownerKey: userOwner, authenticatedUserKey: userOwner };
    }
    // Presence may identify the authenticated user after setup starts. Remember
    // that identity for reconnects without rotating the live session it now owns.
    return {
      ownerKey: previousOwner ?? userOwner,
      authenticatedUserKey: userOwner,
    };
  }
  if (previousUser) {
    return { ownerKey: previousOwner, authenticatedUserKey: previousUser };
  }
  if (previousOwner?.startsWith("device:")) {
    const ownerKey =
      deviceOwner === previousOwner
        ? previousOwner
        : (deviceOwner ?? connectionOwner ?? previousOwner);
    return { ownerKey, authenticatedUserKey: null };
  }
  if (previousOwner?.startsWith("connection:")) {
    const ownerKey =
      connectionOwner === previousOwner
        ? previousOwner
        : (deviceOwner ?? connectionOwner ?? previousOwner);
    return { ownerKey, authenticatedUserKey: null };
  }
  return {
    ownerKey: deviceOwner ?? connectionOwner ?? previousOwner,
    authenticatedUserKey: null,
  };
}

/** Pins continuity to authenticated lineage so later presence cannot rotate live setup. */
export function resolveCustodianSessionContinuity(params: {
  connection: ApplicationGatewayConnection;
  snapshot: ApplicationGatewaySnapshot;
  previous: CustodianSessionContinuity | null;
}): CustodianSessionContinuity {
  const hello = params.snapshot.hello;
  const processInstanceId = hello
    ? readRecordString(hello.snapshot, "processInstanceId")
    : (params.previous?.processInstanceId ?? null);
  const { ownerKey, authenticatedUserKey } = resolveCustodianOwner({
    hello,
    snapshot: params.snapshot,
    previous: params.previous,
  });
  const { gatewayUrl, token, password, bootstrapToken } = params.connection;
  return {
    ownerKey,
    authenticatedUserKey,
    processInstanceId,
    key: JSON.stringify([gatewayUrl, token, password, bootstrapToken, ownerKey, processInstanceId]),
  };
}

export function hasCustodianUserInput(params: SystemAgentChatParams): boolean {
  return params.message !== undefined || params.wizardAnswer !== undefined;
}

export function resolveCustodianConfiguredInferenceState(
  context: ApplicationContext | null,
): CustodianConfiguredInferenceState {
  if (!context || context.gateway.snapshot.phase !== "connected") {
    return "unresolved";
  }
  const agentsList = context.agents.state.agentsList;
  if (!agentsList) {
    return "unresolved";
  }
  const selectedId = normalizeAgentId(
    context.gateway.snapshot.assistantAgentId ?? agentsList.defaultId ?? "",
  );
  const selectedAgent = agentsList.agents.find(
    (agent) => normalizeAgentId(agent.id) === selectedId,
  );
  if (!selectedAgent) {
    return "unresolved";
  }
  return selectedAgent.model?.primary?.trim() ? "ready" : "required";
}

export function sessionVariant(
  onboarding: boolean,
  newAgentIntent: boolean,
): CustodianSessionVariant {
  return onboarding ? "onboarding" : newAgentIntent ? "new-agent" : "caretaker";
}

export function custodianChatParams(
  variant: CustodianSessionVariant,
  message?: string,
): Pick<SystemAgentChatParams, "welcomeVariant" | "message" | "context"> {
  const variantParams = variant === "caretaker" ? {} : { welcomeVariant: variant };
  if (message === undefined) {
    return variantParams;
  }
  const pathname = window.location.pathname;
  const page = routeIdFromPath(pathname, inferBasePathFromPathname(pathname));
  return { ...variantParams, message, ...(page ? { context: { page } } : {}) };
}

export function isCustodianSessionInvalidatedError(error: unknown): boolean {
  const details =
    error && typeof error === "object" ? (error as { details?: unknown }).details : undefined;
  return readSystemAgentSessionInvalidatedErrorDetails(details) !== undefined;
}
