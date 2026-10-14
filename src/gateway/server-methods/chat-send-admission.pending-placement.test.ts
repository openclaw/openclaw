import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { stagePlacementTurnClaimWorkerPublication } from "../worker-environments/placement-turn-authority.js";
import { admitChatSend } from "./chat-send-admission.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession, qualifyChatSendSession } from "./chat-send-session.js";

it.each([
  {
    name: "ineligible internal backend",
    external: false,
    initialRequired: false,
    required: false,
    allowed: true,
    reloadDuringRead: false,
  },
  {
    name: "required-profile external backend",
    external: true,
    initialRequired: true,
    required: true,
    allowed: true,
    reloadDuringRead: false,
  },
  {
    name: "local-to-required policy reload",
    external: true,
    initialRequired: false,
    required: true,
    allowed: true,
    reloadDuringRead: false,
  },
  {
    name: "local-to-required during placement preparation",
    external: true,
    initialRequired: false,
    required: true,
    allowed: true,
    reloadDuringRead: true,
  },
  {
    name: "required-to-local policy reload",
    external: true,
    initialRequired: true,
    required: false,
    allowed: false,
    reloadDuringRead: false,
  },
])("preserves pending placement fences for $name", async (testCase) => {
  await withOpenClawTestState({ label: "backend-chat-pending-placement" }, async () => {
    await loadOrCreateProcessDeviceIdentityAsync();
    let cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {} } },
      ...(testCase.initialRequired ? { cloudWorkers: { requiredProfile: "native" } } : {}),
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:backend-pending-placement",
      sessionId: "backend-pending-placement",
    };
    const runId = "backend-pending-placement-send";
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const placements = createWorkerSessionPlacementStore();
    const requested = await placements.startDispatch(scope);
    const client = sharingPolicyClient({
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    client.connect.client = {
      id: "gateway-client",
      version: "test",
      platform: "test",
      mode: "backend",
    };
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      workerSessionPlacementService: placements,
    });
    const request = await normalizeChatSendRequest({
      client,
      params: { sessionKey: scope.sessionKey, message: "Hello", idempotencyKey: runId },
    });
    if (!request.ok) {
      throw new Error(request.error);
    }
    const prepared = await prepareChatSendSession({
      request: request.value,
      client,
      context,
      isDirectExternalUser: testCase.external,
    });
    if (!prepared.ok) {
      throw new Error("Session preparation failed");
    }
    expect(Boolean(prepared.value.restartSafeRequest)).toBe(testCase.external);
    const session = await qualifyChatSendSession(prepared.value);
    const reloadPolicy = () => {
      cfg = {
        ...cfg,
        cloudWorkers: testCase.required ? { requiredProfile: "native" } : undefined,
      };
      setRuntimeConfigSnapshot(cfg, cfg);
    };
    if (testCase.required !== testCase.initialRequired && !testCase.reloadDuringRead) {
      reloadPolicy();
    }
    const read = await placements.prepareSessionPlacement(scope.sessionId);
    const pending = stagePlacementTurnClaimWorkerPublication(
      requireOpenClawStateDatabaseIdentity({ db: openOpenClawStateDatabase().db }),
      requested,
      undefined,
      requested.state,
      requested,
    );
    const preparePlacement = placements.prepareSessionPlacement.bind(placements);
    const reloadingRead = testCase.reloadDuringRead
      ? vi
          .spyOn(placements, "prepareSessionPlacement")
          .mockImplementationOnce(async (sessionId) => {
            const facts = await preparePlacement(sessionId);
            reloadPolicy();
            return facts;
          })
      : undefined;
    const respond = vi.fn();
    let admitted: Awaited<ReturnType<typeof admitChatSend>> | undefined;
    try {
      expect(() => read.current()).toThrow("placement authority changed");
      admitted = await admitChatSend({
        request: request.value,
        session,
        client,
        context,
        respond,
      });
      expect(admitted.ok, JSON.stringify(respond.mock.calls)).toBe(testCase.allowed);
      expect(context.chatAbortControllers.has(runId)).toBe(testCase.allowed);
      if (!testCase.allowed) {
        expect(respond.mock.calls[0]?.[2]?.message).toContain("placement authority changed");
      }
      expect(() => read.current()).toThrow("placement authority changed");
    } finally {
      reloadingRead?.mockRestore();
      pending.rollback();
      read.release();
      if (admitted?.ok) {
        admitted.value.cleanupAdmittedRun();
      }
      clearAgentRunContext(runId);
    }
  });
});
