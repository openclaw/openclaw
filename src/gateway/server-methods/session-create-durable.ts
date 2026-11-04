import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  validateSessionsCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { SessionCreationOperation } from "../../config/sessions/session-creation-operation.js";
import { readSessionCreationReceiptInWorker } from "../../config/sessions/session-creation-receipt-read.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import { resolveSessionPublicShare } from "../../config/sessions/session-public-share.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { prepareGatewaySessionLifecycleTargets } from "../session-lifecycle-preparation.js";
import {
  sessionMutationForbiddenError,
  SessionMutationAuthorizationChangedError,
} from "../session-mutation-authorization-error.js";
import { resolveSessionCreateAgentId } from "../session-request-agent.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import type { GatewayInflightResult } from "./inflight.js";
import { idempotentSessionCreate } from "./session-create-idempotency.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  readGatewayRequestMutationAuthority,
} from "./session-mutation-guards.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions } from "./types.js";

type ReplayPublication = {
  resources: AsyncDisposableStack;
  assertCurrent?: () => void;
};

/** Binds the existing public idempotency key; no deployment-specific inputs or session IDs. */
async function prepareCreation(request: GatewayRequestHandlerOptions) {
  const p = request.params;
  if (
    !validateSessionsCreateParams(p) ||
    !p.idempotencyKey ||
    p.incognito ||
    isIncognitoSessionKey(p.key) ||
    isIncognitoSessionKey(p.parentSessionKey)
  ) {
    return undefined;
  }
  const operator = request.client?.internal?.operatorRunAuthority;
  const principal =
    request.client?.authenticatedUserProfile?.profileId ??
    request.client?.authenticatedUserId ??
    operator?.profileId;
  const device = request.client?.connect.device?.id?.trim();
  if (!principal && !device) {
    return undefined; // The enclosing idempotency owner rejects anonymous keys.
  }
  const owner = principal ? "principal:" + principal : "device:" + device;
  const cfg = request.context.getRuntimeConfig();
  const selected = resolveSessionCreateAgentId(cfg, p);
  if (!selected.ok) {
    return { error: selected.error };
  }
  const authority = readGatewayRequestMutationAuthority(request);
  const assertCurrent = () => {
    try {
      authority.assertCurrent();
      operator?.assertCurrent();
      request.sessionMutationAuthorization?.assertCurrent();
    } catch {
      // The added preflight must keep creation's public authorization envelope,
      // including cancellation of an already-admitted tool invocation.
      throw sessionMutationForbiddenError(
        "Session creation requires a current authorized requester.",
      );
    }
  };
  assertCurrent();
  const operation: SessionCreationOperation = {
    digest: sha256Hex(JSON.stringify(["session.create", owner, p.idempotencyKey])),
    fingerprint: sha256Hex(stableStringify(p)),
    authorization: {
      role: request.client?.connect.role ?? null,
      scopes: request.client?.connect.scopes?.toSorted() ?? [],
    },
  };
  const agentId = selected.agentId;
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const stored = await readSessionCreationReceiptInWorker(
    { agentId, storePath },
    operation.digest,
    assertCurrent,
  );
  return { cfg, agentId, storePath, operation, stored, assertCurrent };
}

async function replayCreation(
  request: GatewayRequestHandlerOptions,
  prepared: Exclude<Awaited<ReturnType<typeof prepareCreation>>, undefined | { error: unknown }>,
  publication: ReplayPublication,
  cached?: GatewayInflightResult,
): Promise<GatewayInflightResult | undefined> {
  const { stored, operation, assertCurrent, agentId, storePath, cfg } = prepared;
  if (!stored) {
    return undefined;
  }
  const { receipt, entry } = stored;
  const reject = (
    message: string,
    code: Parameters<typeof errorShape>[0] = ErrorCodes.INVALID_REQUEST,
  ): GatewayInflightResult => ({
    ok: false,
    error: errorShape(code, message),
  });
  if (receipt.fingerprint !== operation.fingerprint) {
    return reject("session creation idempotency key was reused with different parameters");
  }
  if (receipt.authorization.role !== operation.authorization.role) {
    return reject("session creation authorization changed; start again", ErrorCodes.FORBIDDEN);
  }
  const missingScope = receipt.authorization.scopes.find(
    (scope) => !operation.authorization.scopes.includes(scope),
  );
  if (missingScope) {
    return {
      ok: false,
      error: missingScopeErrorShape({ missingScope, requiredScopes: receipt.authorization.scopes }),
    };
  }
  if (
    !entry ||
    entry.sessionId !== receipt.sessionId ||
    (entry.lifecycleRevision ?? null) !== receipt.lifecycleRevision
  ) {
    return reject("The original creation incarnation is no longer available.");
  }
  const target = { agentId, storePath, canonicalKey: receipt.sessionKey };
  const lifecycle = publication.resources.use(
    prepareGatewaySessionLifecycleTargets({
      cfg,
      getCurrentConfig: request.context.getRuntimeConfig,
      targets: [{ target, entry }],
    }),
  );
  const held = await Promise.all(lifecycle.preparations);
  const sharing = await resolveSessionMutationAuthorizationAsync({
    client: request.client,
    context: request.context,
    method: "sessions.create",
    requestParams: { key: receipt.sessionKey, agentId },
    expectedTarget: {
      agentId,
      storePath,
      sessionKey: receipt.sessionKey,
      sessionId: receipt.sessionId,
    },
    sessionScope: readGatewayRequestMutationAuthority(request).sessionScope,
    assertInvocationCurrent: assertCurrent,
  });
  publication.resources.defer(() => sharing.authorization?.release?.());
  if (sharing.error) {
    return { ok: false, error: sharing.error };
  }
  publication.assertCurrent = () => {
    assertCurrent();
    sharing.authorization?.assertCurrent();
    lifecycle.assertCurrent();
    if (!held.every((source) => source.matchesCurrent(request.context.getRuntimeConfig()))) {
      throw new SessionMutationAuthorizationChangedError(
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "The original creation incarnation is no longer available.",
        ),
      );
    }
  };
  publication.assertCurrent();
  // A replay-filled process cache can outlive its durable receipt. Only reuse the
  // response for this exact incarnation; a replaced receipt supplies its own projection.
  if (
    cached &&
    isRecord(cached.payload) &&
    cached.payload.key === receipt.sessionKey &&
    cached.payload.sessionId === receipt.sessionId &&
    isRecord(cached.payload.entry) &&
    (cached.payload.entry.lifecycleRevision ?? null) === receipt.lifecycleRevision
  ) {
    return cached;
  }
  const model = resolveSessionModelRef(request.context.getRuntimeConfig(), entry, agentId);
  return {
    ok: true,
    payload: {
      ok: true,
      key: receipt.sessionKey,
      sessionId: entry.sessionId,
      entry: projectPublicSessionEntry(entry),
      runStarted: false,
      creationReplayed: true,
      publicRead: Boolean(resolveSessionPublicShare(entry)),
      resolved: { modelProvider: model.provider, model: model.model },
    },
    meta: { cached: true },
  };
}

function durableSessionCreate(
  handler: GatewayRequestHandler,
  publication: ReplayPublication,
): GatewayRequestHandler {
  return async (request) => {
    const prepared = await prepareCreation(request);
    if (prepared && "error" in prepared) {
      request.respond(false, undefined, prepared.error);
      return;
    }
    const replay = prepared ? await replayCreation(request, prepared, publication) : undefined;
    if (replay) {
      request.respond(replay.ok, replay.payload, replay.error, replay.meta);
      return;
    }
    await handler(
      bindGatewayRequestHandlerMutationAuthority(
        request,
        {
          ...request,
          sessionCreationOperation: prepared?.operation,
        },
        undefined,
      ),
    );
  };
}

/** Even the warm cache must prove current caller and original session incarnation. */
async function replayDurableSessionCreate(
  request: GatewayRequestHandlerOptions,
  cached: GatewayInflightResult,
  publication: ReplayPublication,
) {
  const prepared = await prepareCreation(request);
  if (prepared && "error" in prepared) {
    return { ok: false, error: prepared.error };
  }
  if (!prepared) {
    readGatewayRequestMutationAuthority(request).assertCurrent();
    return cached;
  }
  return (
    (await replayCreation(request, prepared, publication, cached)) ?? {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "Session creation receipt expired; start again."),
    }
  );
}

export function idempotentDurableSessionCreate(
  handler: GatewayRequestHandler,
): GatewayRequestHandler {
  return async (request) => {
    // Replay leases belong to this invocation, never to a cached result. Idempotency
    // awaits after capturing the inner response, so retain them through actual publication.
    await using resources = new AsyncDisposableStack();
    const publication: ReplayPublication = { resources };
    const create = idempotentSessionCreate(
      durableSessionCreate(handler, publication),
      (replayRequest, cached) => replayDurableSessionCreate(replayRequest, cached, publication),
    );
    const respond: GatewayRequestHandlerOptions["respond"] = (...args) => {
      if (args[0]) {
        publication.assertCurrent?.();
      }
      request.respond(...args);
    };
    try {
      await create(
        bindGatewayRequestHandlerMutationAuthority(request, { ...request, respond }, undefined),
      );
    } catch (error) {
      if (!(error instanceof SessionMutationAuthorizationChangedError)) {
        throw error;
      }
      request.respond(false, undefined, error.error);
    }
  };
}
