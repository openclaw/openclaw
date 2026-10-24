import { expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { captureGatewayAuthPolicy } from "../auth-policy.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { canReceiveSessionEvent, prepareProjectedSessionSharing } from "../session-sharing.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { writeQuestionFixtureEntry } from "./question.registration-collision.test-harness.js";
import {
  broadcast,
  callQuestionRpc,
  createQuestionTestPeer,
  manager,
  requestParams,
} from "./question.test-support.js";
import type { GatewayClient } from "./types.js";

const sessionScope = { agentId: "main", sessionKey: requestParams.sessionKey };

export async function createOwnRunFixture(
  durable = false,
  legacyGeneration = false,
  creatorProfileId?: string,
) {
  if (durable) {
    // The real SQLite worker owns wall-clock deadlines outside Vitest's process clock.
    vi.useRealTimers();
  }
  const profile = ensureProfileForEmail("guest@example.test");
  const cfg: OpenClawConfig = {
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "view" },
            agents: "*",
            scopes: ["operator.sessions.write", "operator.sessions.read"],
          },
          suspended: { sessions: { others: "none" }, agents: [], scopes: [] },
        },
      },
    },
  };
  const entry: SessionEntry = {
    sessionId: "guest-question-session",
    ...(legacyGeneration ? {} : { lifecycleRevision: "guest-question-generation" }),
    updatedAt: 1,
    visibility: "shared",
    createdActor: { type: "human", source: "profile", id: creatorProfileId ?? profile.id },
  };
  setRuntimeConfigSnapshot(cfg);
  await writeQuestionFixtureEntry(sessionScope, entry, legacyGeneration);
  const browser = createQuestionTestPeer(profile, "original-browser");
  if (durable) {
    browser.client.internal = { authenticatedOperator: true };
    browser.client.authPolicy = captureGatewayAuthPolicy(cfg, {
      role: "operator",
      authMethod: "token",
    });
  }
  const sourceController = new AbortController();
  const source = await captureGatewayOperatorRunAuthority({
    client: browser.client,
    context: { getRuntimeConfig: () => cfg },
    sourceAuthority: {
      ...(durable ? { gatewayAccessGrant: null } : {}),
      signal: sourceController.signal,
      assertCurrent: () => sourceController.signal.throwIfAborted(),
    },
  });
  if (!source) {
    throw new Error("expected the Guest's admitted operator authority");
  }
  const authority = claimAgentRunDelegatedAuthority(
    { instanceId: "guest-question-run", runId: requestParams.runId },
    source.authority.assertCurrent,
  );
  const synthetic = createSyntheticPluginRuntimeClient({
    operatorRoleActor: { kind: "operator", profileId: profile.id },
    operatorRunAuthority: source.authority,
    scopes: ["operator.sessions.write"],
  });
  const runtime: GatewayClient = {
    ...synthetic,
    internal: {
      ...synthetic.internal,
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: requestParams.agentId,
        sessionKey: requestParams.sessionKey,
        operationalRunInstance: authority.operationalRunInstance,
        delegatedAuthority: { kind: "local", ...authority },
      },
    },
  };
  const projection = await createSessionRowProjection({ cfg });
  await projection.ensureMaterialized();
  const clients = new GatewayClientRegistry([browser.client]);
  const broadcaster = createGatewayBroadcaster({
    clients,
    canReceiveSessionEvent: (client, sessionKeys, agentId, event, payload) =>
      canReceiveSessionEvent({
        cfg,
        client,
        sessionKeys,
        agentId,
        event,
        payload,
        prepared: {
          sharing: prepareProjectedSessionSharing({
            cfg,
            client,
            isMember: (target, identityId) =>
              projection.hasMembership(target.storePath, target.storeKey, identityId),
          }),
          target: (key, targetAgentId) => {
            const { agentId: ownerAgentId } = resolveSessionStoreIdentity({
              cfg,
              sessionKey: key,
              agentId: targetAgentId,
            });
            return projection.sharingTarget({ key, agentId: ownerAgentId });
          },
        },
      }),
  });
  broadcast.mockImplementation(broadcaster.broadcast);
  const call = (
    method: string,
    params: Record<string, unknown>,
    client: GatewayClient = browser.client,
  ) => callQuestionRpc(method, params, { cfg, client, registered: true });
  const request = async () => {
    const response = await call("question.request", requestParams, runtime);
    expect(response[0], JSON.stringify(response[2])).toBe(true);
    return (response[1] as { id: string }).id;
  };
  const beginWait = async (
    id: string,
    client: GatewayClient = browser.client,
    hasCurrentClientAuthority?: () => boolean,
  ) => {
    const attached = createDeferred();
    const waitAnswer = manager.waitAnswer.bind(manager);
    const observer = vi.spyOn(manager, "waitAnswer").mockImplementationOnce((...args) => {
      const result = waitAnswer(...args);
      attached.resolve();
      return result;
    });
    const result = callQuestionRpc(
      "question.waitAnswer",
      { id },
      {
        cfg,
        client,
        registered: true,
        hasCurrentClientAuthority,
      },
    );
    try {
      await Promise.race([
        attached.promise,
        result.then((response) => {
          throw new Error("question waiter was not admitted: " + JSON.stringify(response[2]));
        }),
      ]);
    } finally {
      observer.mockRestore();
    }
    return { result };
  };
  return {
    profile,
    cfg,
    entry,
    browser,
    runtime,
    clients,
    broadcaster,
    authority,
    source,
    revokeSource: () => sourceController.abort(new Error("Original question source revoked")),
    call,
    request,
    beginWait,
    close: async () => {
      try {
        manager.reset();
        await manager.drain();
        releaseAgentRunDelegatedAuthority(authority);
        source.release();
      } finally {
        projection.dispose();
      }
    },
  };
}
