import {
  ErrorCodes,
  errorShape,
  type SessionsShareCreateParams,
  validateSessionsShareCreateParams,
  validateSessionsShareListParams,
  validateSessionsShareRevokeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveControlPlaneActor } from "../control-plane-audit.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../server-methods/types.js";
import { assertValidParams } from "../server-methods/validation.js";
import { GuestGrantStore, type GuestGrant, type GuestInvitedPrincipal } from "./grant-store.js";

const DEFAULT_JOIN_URL_BASE = "https://genie.deva.me/join";

type GuestShareHandlerOptions = {
  store?: GuestGrantStore;
  joinUrlBase?: string;
};

type GuestGrantSummary = Omit<GuestGrant, "codeHash">;

let defaultStore: GuestGrantStore | undefined;

function getDefaultStore(): GuestGrantStore {
  return (defaultStore ??= new GuestGrantStore());
}

function grantSummary(grant: GuestGrant): GuestGrantSummary {
  return {
    grantId: grant.grantId,
    sessionKey: grant.sessionKey,
    mode: grant.mode,
    audience: grant.audience,
    ...(grant.invitedPrincipal ? { invitedPrincipal: grant.invitedPrincipal } : {}),
    createdBy: grant.createdBy,
    createdAtMs: grant.createdAtMs,
    expiresAtMs: grant.expiresAtMs,
    ...(grant.revokedAtMs === undefined ? {} : { revokedAtMs: grant.revokedAtMs }),
    replayPolicy: grant.replayPolicy,
    ...(grant.maxConcurrentGuests === undefined
      ? {}
      : { maxConcurrentGuests: grant.maxConcurrentGuests }),
  };
}

function resolveInvitedPrincipal(
  params: SessionsShareCreateParams,
): GuestInvitedPrincipal | undefined {
  if (params.access === "invite") {
    if (!params.invitedPrincipal) {
      throw new Error("invitedPrincipal is required when access is invite");
    }
    return params.invitedPrincipal;
  }
  if (params.invitedPrincipal) {
    throw new Error("invitedPrincipal is only valid when access is invite");
  }
  return undefined;
}

function normalizeJoinUrlBase(value: string): string {
  const normalized = value.trim();
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("guest share join URL base must use http or https");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("guest share join URL base must not include a query or fragment");
  }
  return normalized.replace(/\/+$/, "");
}

function resolveJoinUrlBase(
  context: GatewayRequestContext,
  configuredBase: string | undefined,
): string {
  return normalizeJoinUrlBase(
    configuredBase ??
      context.getRuntimeConfig().gateway?.guestShare?.joinUrlBase ??
      DEFAULT_JOIN_URL_BASE,
  );
}

function respondWithInvalidRequest(
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  error: unknown,
): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, error instanceof Error ? error.message : String(error)),
  );
}

export function createGuestShareHandlers(
  options: GuestShareHandlerOptions = {},
): GatewayRequestHandlers {
  const resolveStore = () => options.store ?? getDefaultStore();
  return {
    "sessions.share.create": ({ params, client, context, respond }) => {
      if (
        !assertValidParams(
          params,
          validateSessionsShareCreateParams,
          "sessions.share.create",
          respond,
        )
      ) {
        return;
      }
      try {
        const store = resolveStore();
        const invitedPrincipal = resolveInvitedPrincipal(params);
        const created = store.createGrant({
          sessionKey: params.sessionKey,
          audience: params.access === "invite" ? "deva-user" : "open",
          ...(invitedPrincipal ? { invitedPrincipal } : {}),
          createdBy: resolveControlPlaneActor(client).deviceId,
          ...(params.expiresAtMs === undefined ? {} : { expiresAtMs: params.expiresAtMs }),
          ...(params.replayPolicy === undefined ? {} : { replayPolicy: params.replayPolicy }),
        });
        const joinUrlBase = resolveJoinUrlBase(context, options.joinUrlBase);
        respond(
          true,
          {
            grantId: created.grant.grantId,
            code: created.code,
            joinUrl: `${joinUrlBase}/${created.code}`,
          },
          undefined,
        );
      } catch (error) {
        respondWithInvalidRequest(respond, error);
      }
    },
    "sessions.share.list": ({ params, respond }) => {
      if (
        !assertValidParams(params, validateSessionsShareListParams, "sessions.share.list", respond)
      ) {
        return;
      }
      try {
        const store = resolveStore();
        const grants = store
          .listGrants(params.sessionKey ? { sessionKey: params.sessionKey } : {})
          .map(grantSummary);
        respond(true, { grants }, undefined);
      } catch (error) {
        respondWithInvalidRequest(respond, error);
      }
    },
    "sessions.share.revoke": ({ params, respond }) => {
      if (
        !assertValidParams(
          params,
          validateSessionsShareRevokeParams,
          "sessions.share.revoke",
          respond,
        )
      ) {
        return;
      }
      try {
        const store = resolveStore();
        const revoked = store.revokeGrant(params.grantId);
        if (revoked?.revokedAtMs === undefined) {
          throw new Error("guest grant not found");
        }
        respond(true, { grantId: revoked.grantId, revokedAtMs: revoked.revokedAtMs }, undefined);
      } catch (error) {
        respondWithInvalidRequest(respond, error);
      }
    },
  };
}

export const guestShareHandlers = createGuestShareHandlers();
