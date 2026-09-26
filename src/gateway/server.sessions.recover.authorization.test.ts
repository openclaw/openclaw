import { afterEach, expect, test, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "./device-revocation.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  seedSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

const operatorRunCaptures = vi.hoisted(() => new Map<string, unknown>());

vi.mock("./operator-run-cancellation.js", async () => {
  const actual = await vi.importActual<typeof import("./operator-run-cancellation.js")>(
    "./operator-run-cancellation.js",
  );
  return {
    ...actual,
    retainGatewayOperatorRun: async (
      params: Parameters<typeof actual.retainGatewayOperatorRun>[0],
    ) => {
      const retained = await actual.retainGatewayOperatorRun(params);
      operatorRunCaptures.set(params.runId, retained);
      return retained;
    },
  };
});

type RecoverPayload = {
  key?: string;
  sessionId?: string;
  continuation?: Record<string, unknown>;
};

function isRecoverPayload(value: unknown): value is RecoverPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    (!("key" in value) || typeof value.key === "string") &&
    (!("sessionId" in value) || typeof value.sessionId === "string") &&
    (!("continuation" in value) ||
      (typeof value.continuation === "object" && value.continuation !== null))
  );
}

function isRetainedOperatorRun(
  value: unknown,
): value is { armCancellation: () => void; release: () => void } {
  return (
    typeof value === "object" &&
    value !== null &&
    "armCancellation" in value &&
    typeof value.armCancellation === "function" &&
    "release" in value &&
    typeof value.release === "function"
  );
}

afterEach(() => {
  operatorRunCaptures.clear();
  closeOpenClawStateDatabaseForTest();
});

async function seedRecoverableSession(params: {
  sourceKey: string;
  sourceSessionId: string;
  storePath: string;
  ownerProfileId: string;
}) {
  await writeSessionStore({
    entries: {
      [params.sourceKey]: sessionStoreEntry(params.sourceSessionId, {
        status: "failed",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: `cycle-${params.sourceSessionId}`,
          revision: 1,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
        createdActor: {
          type: "human",
          source: "profile",
          id: params.ownerProfileId,
        },
      }),
    },
  });
  await seedSessionTranscript({
    agentId: "main",
    sessionId: params.sourceSessionId,
    sessionKey: params.sourceKey,
    storePath: params.storePath,
    messages: [{ role: "user", content: "finish the interrupted work" }],
  });
}

async function registeredSessionRecover(params: {
  client: Parameters<typeof handleGatewayRequest>[0]["client"];
  context: Parameters<typeof handleGatewayRequest>[0]["context"];
  id: string;
  key: string;
  hasCurrentClientAuthority?: () => boolean;
}) {
  let response:
    | {
        ok: boolean;
        payload?: RecoverPayload;
        error?: { code?: string; message?: string };
      }
    | undefined;
  await handleGatewayRequest({
    req: {
      type: "req",
      id: params.id,
      method: "sessions.recover",
      params: { agentId: "main", key: params.key },
    },
    client: params.client,
    context: params.context,
    respond: (ok, payload, error) => {
      if (payload !== undefined && !isRecoverPayload(payload)) {
        throw new Error("sessions.recover returned an invalid payload");
      }
      response = { ok, payload, error };
    },
    isWebchatConnect: () => false,
    ...(params.hasCurrentClientAuthority
      ? { hasCurrentClientAuthority: params.hasCurrentClientAuthority }
      : {}),
  });
  if (!response) {
    throw new Error("registered sessions.recover did not respond");
  }
  return response;
}

function recoveryConfig(storePath: string) {
  const cfg = getRuntimeConfig();
  return {
    ...cfg,
    gateway: { ...cfg.gateway, roles: rolePolicyConfig().gateway!.roles },
    session: { ...cfg.session, store: storePath },
  };
}

test("sessions.recover denies a narrow continuation into a linked foreign successor", async () => {
  const { storePath } = await createSessionStoreDir();
  const sourceKey = "agent:main:dashboard:linked-foreign-recovery";
  const sourceSessionId = "linked-foreign-recovery-source";
  const sourceOwner = roleClient("view", "linked-recovery-owner");
  sourceOwner.connect.scopes = ["operator.sessions.write"];
  const broadWriter = roleClient("write", "linked-recovery-writer");
  broadWriter.connect.scopes = ["operator.write"];
  const cfg = recoveryConfig(storePath);
  const revokedRole = rolePolicyConfig().gateway!.roles!;
  const writeRole = revokedRole.definitions.write;
  if (!writeRole) {
    throw new Error("role policy fixture has no write role");
  }
  writeRole.sessions = { others: "view" };
  const revokedCfg = { ...cfg, gateway: { ...cfg.gateway, roles: revokedRole } };
  await seedRecoverableSession({
    sourceKey,
    sourceSessionId,
    storePath,
    ownerProfileId: sourceOwner.authenticatedUserProfile!.profileId,
  });
  const context = createDirectChatContext({
    getRuntimeConfig: () =>
      loadSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath })?.mainRestartRecovery
        ?.tombstone?.recoveredSessionKey
        ? revokedCfg
        : cfg,
  });

  const initial = await registeredSessionRecover({
    client: broadWriter,
    context,
    id: "linked-recovery-create",
    key: sourceKey,
  });
  expect(initial.ok, JSON.stringify(initial)).toBe(true);
  expect(initial).toMatchObject({
    ok: true,
    payload: { key: expect.any(String), continuation: { status: "rejected" } },
  });
  const successorKey = initial.payload?.key ?? "";
  const successorSessionId = initial.payload?.sessionId ?? "";
  const successorScope = { agentId: "main", sessionKey: successorKey, storePath };
  expect(loadSessionEntry(successorScope)?.createdActor).toEqual({
    type: "human",
    source: "profile",
    id: broadWriter.authenticatedUserProfile!.profileId,
  });
  const transcriptBefore = await loadTranscriptEvents({
    ...successorScope,
    sessionId: successorSessionId,
  });
  const runCountBefore = vi.mocked(context.addChatRun).mock.calls.length;

  const retried = await registeredSessionRecover({
    client: sourceOwner,
    context,
    id: "linked-recovery-narrow-retry",
    key: sourceKey,
  });

  expect(retried).toMatchObject({
    ok: true,
    payload: {
      key: successorKey,
      sessionId: successorSessionId,
      continuation: {
        status: "rejected",
        error: { code: "FORBIDDEN", message: "Session-scoped writes require your own session." },
      },
    },
  });
  expect(vi.mocked(context.addChatRun).mock.calls.length).toBe(runCountBefore);
  await expect(
    loadTranscriptEvents({ ...successorScope, sessionId: successorSessionId }),
  ).resolves.toEqual(transcriptBefore);
  expect(operatorRunCaptures.size).toBe(0);

  await addSessionMember(successorScope, {
    identityId: sourceOwner.authenticatedUserProfile!.profileId,
    addedBy: broadWriter.authenticatedUserProfile!.profileId,
    expectedSessionId: successorSessionId,
  });
  sourceOwner.connect.scopes = ["operator.write"];
  const allowedContext = createDirectChatContext({ getRuntimeConfig: () => cfg });
  const granted = await registeredSessionRecover({
    client: sourceOwner,
    context: allowedContext,
    id: "linked-recovery-explicit-member",
    key: sourceKey,
  });
  expect(granted).toMatchObject({
    ok: true,
    payload: {
      key: successorKey,
      sessionId: successorSessionId,
      continuation: { status: "started" },
    },
  });
  const memberRunId = granted.payload?.continuation?.runId;
  expect(typeof memberRunId === "string" && operatorRunCaptures.has(memberRunId)).toBe(true);
  expect(allowedContext.addChatRun).toHaveBeenCalledOnce();
});

test("sessions.recover retains source revocation for its accepted own successor", async () => {
  const { storePath } = await createSessionStoreDir();
  const sourceKey = "agent:main:dashboard:narrow-own-recovery";
  const sourceSessionId = "narrow-own-recovery-source";
  const owner = roleClient("view", "narrow-recovery-owner");
  owner.connect.scopes = ["operator.sessions.write"];
  await seedRecoverableSession({
    sourceKey,
    sourceSessionId,
    storePath,
    ownerProfileId: owner.authenticatedUserProfile!.profileId,
  });
  const context = createDirectChatContext({ getRuntimeConfig: () => recoveryConfig(storePath) });
  const requestAuthority = captureGatewayDeviceRevocation(
    context,
    { deviceId: "narrow-recovery-device", role: "operator" },
    () => true,
  );
  const recovered = await registeredSessionRecover({
    client: owner,
    context,
    id: "narrow-own-recovery",
    key: sourceKey,
    hasCurrentClientAuthority: requestAuthority.isCurrent,
  });

  expect(recovered).toMatchObject({
    ok: true,
    payload: { key: expect.any(String), continuation: { status: "started" } },
  });
  const runId = recovered.payload?.continuation?.runId;
  if (typeof runId !== "string") {
    throw new Error("recovery did not return its admitted run");
  }
  const acceptedRun = context.chatAbortControllers.get(runId);
  if (!acceptedRun) {
    throw new Error("recovery did not register its active run");
  }
  const retainedRun = operatorRunCaptures.get(runId);
  if (!isRetainedOperatorRun(retainedRun)) {
    throw new Error("recovery did not retain its operator run authority");
  }
  const cancellationWork: Promise<unknown>[] = [];
  context.trackExecution = async (run) => {
    const operation = Promise.resolve().then(run);
    cancellationWork.push(operation);
    return await operation;
  };
  let providerCancellationObserved = false;
  acceptedRun.controller.signal.addEventListener(
    "abort",
    () => {
      providerCancellationObserved = true;
    },
    { once: true },
  );
  retainedRun.armCancellation();
  requestAuthority.release();
  expect(requestAuthority.isCurrent()).toBe(true);
  expect(acceptedRun.controller.signal.aborted).toBe(false);
  invalidateGatewayDeviceRevocation(context, "narrow-recovery-device", "operator");
  await Promise.allSettled(cancellationWork);
  expect(requestAuthority.isCurrent()).toBe(false);
  expect(acceptedRun.controller.signal.aborted).toBe(true);
  expect(providerCancellationObserved).toBe(true);
  expect(context.removeChatRun).toHaveBeenCalled();
  retainedRun.release();
  const recoveredKey = recovered.payload?.key ?? "";
  expect(
    loadSessionEntry({
      agentId: "main",
      sessionKey: recoveredKey,
      storePath,
    })?.createdActor,
  ).toEqual({ type: "human", source: "profile", id: owner.authenticatedUserProfile!.profileId });
});
