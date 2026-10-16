import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
} from "../../agents/run-termination.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import * as sessionLifecycle from "../../sessions/session-lifecycle-admission.js";
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

it.each(["restart", "stop"] as const)(
  "preserves client retry only when an unstarted chat admission is interrupted by %s",
  async (reason) => {
    await withOpenClawTestState({ label: "chat-pending-restart" }, async () => {
      await loadOrCreateProcessDeviceIdentityAsync();
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {} } },
      };
      setRuntimeConfigSnapshot(cfg, cfg);
      const sessionKey = "agent:main:dashboard:pending-restart";
      const runId = "pending-restart-input";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        { sessionId: "pending-restart-session", updatedAt: 1 },
      );
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const request = await normalizeChatSendRequest({
        client: null,
        params: { sessionKey, message: "Keep this input", idempotencyKey: runId },
      });
      if (!request.ok) {
        throw new Error(request.error);
      }
      const prepared = await prepareChatSendSession({
        request: request.value,
        client: null,
        context,
      });
      if (!prepared.ok) {
        throw new Error("Session preparation failed");
      }
      const session = await qualifyChatSendSession(prepared.value);
      const target = {
        scope: session.storePath,
        identities: [sessionKey, session.backingSessionId],
      };
      const entered = createDeferred();
      const release = createDeferred();
      const blocker = sessionLifecycle.runExclusiveSessionLifecycleMutation("patch", {
        ...target,
        prepare: async () => {
          entered.resolve();
          await release.promise;
        },
        run: async () => {},
      });
      await entered.promise;
      const queued = createDeferred();
      const begin = sessionLifecycle.beginSessionWorkAdmission;
      using observation = vi.spyOn(sessionLifecycle, "beginSessionWorkAdmission");
      observation.mockImplementationOnce((params) => {
        const admission = begin(params);
        queued.resolve();
        return admission;
      });
      const respond = vi.fn();
      const params = { request: request.value, session, client: null, context, respond };
      const pending = admitChatSend(params);
      let retried: Awaited<ReturnType<typeof admitChatSend>> | undefined;
      try {
        await awaitGateBeforeSettlement(queued.promise, pending, "chat skipped pending admission");
        await sessionLifecycle.startSessionWorkAdmissionInterruption({
          ...target,
          reason:
            reason === "restart"
              ? createAgentRunRestartAbortError()
              : createAgentRunDirectAbortError(),
        }).released;
        expect(await pending).toMatchObject({ ok: false });
        expect(context.chatAbortControllers.has(runId)).toBe(false);
        expect(context.dedupe.has(session.pendingChatSendKey)).toBe(false);
        if (reason === "restart") {
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              code: "UNAVAILABLE",
              retryable: true,
              details: { reason: "gateway-restarting" },
            }),
          );
          expect(context.chatRunState.hasAbortMarker(runId)).toBe(false);
          expect(context.dedupe.has(`chat:${runId}`)).toBe(false);
          release.resolve();
          await blocker;
          retried = await admitChatSend(params);
          expect(retried.ok).toBe(true);
        } else {
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ runId, status: "timeout", stopReason: "rpc" }),
            undefined,
            expect.objectContaining({ cached: true }),
          );
          expect(context.chatRunState.hasAbortMarker(runId)).toBe(true);
        }
      } finally {
        release.resolve();
        await blocker;
        await pending;
        if (retried?.ok) {
          retried.value.cleanupAdmittedRun();
        }
        clearAgentRunContext(runId);
      }
    });
  },
);

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

it.each<{ name: string; patch: OpenClawConfig; allowed: boolean }>([
  {
    name: "unrelated plugin settings",
    patch: { plugins: { entries: { "memory-core": { config: { dreaming: { enabled: true } } } } } },
    allowed: true,
  },
  {
    name: "selected model",
    patch: {
      agents: {
        ownership: "explicit",
        entries: { main: {} },
        defaults: { model: { primary: "openai/changed" } },
      },
    },
    allowed: false,
  },
  { name: "tool policy", patch: { tools: { deny: ["exec"] } }, allowed: false },
  { name: "global plugin enablement", patch: { plugins: { enabled: false } }, allowed: false },
  { name: "plugin allowlist", patch: { plugins: { allow: ["memory-core"] } }, allowed: false },
  { name: "plugin denylist", patch: { plugins: { deny: ["openai"] } }, allowed: false },
  {
    name: "harness enablement",
    patch: { plugins: { entries: { codex: { enabled: false } } } },
    allowed: false,
  },
  {
    name: "plugin slot",
    patch: { plugins: { slots: { contextEngine: "other" } } },
    allowed: false,
  },
])("rechecks prepared chat facts across a reload of $name", async ({ patch, allowed }) => {
  await withOpenClawTestState({ label: "chat-reload-preparation" }, async () => {
    await loadOrCreateProcessDeviceIdentityAsync();
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {} } },
      plugins: {
        entries: {
          "memory-core": { config: { dreaming: { enabled: false } } },
          codex: { enabled: true },
        },
      },
    };
    let currentConfig = cfg;
    setRuntimeConfigSnapshot(cfg, cfg);
    const sessionKey = "agent:main:dashboard:reload-preparation";
    const runId = "chat-reload-preparation";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey },
      { sessionId: "reload-preparation-session", updatedAt: 1 },
    );
    const request = await normalizeChatSendRequest({
      client: null,
      params: { sessionKey, message: "Keep this turn", idempotencyKey: runId },
    });
    if (!request.ok) {
      throw new Error(request.error);
    }
    const context = createDirectChatContext({ getRuntimeConfig: () => currentConfig });
    const prepared = await prepareChatSendSession({
      request: request.value,
      client: null,
      context,
    });
    if (!prepared.ok) {
      throw new Error("Session preparation failed");
    }
    const session = await qualifyChatSendSession(prepared.value);
    currentConfig = {
      ...cfg,
      ...patch,
      plugins: {
        ...cfg.plugins,
        ...patch.plugins,
        entries: { ...cfg.plugins?.entries, ...patch.plugins?.entries },
      },
    };
    setRuntimeConfigSnapshot(currentConfig, currentConfig);
    const respond = vi.fn();
    let admitted: Awaited<ReturnType<typeof admitChatSend>> | undefined;
    try {
      admitted = await admitChatSend({
        request: request.value,
        session,
        client: null,
        context,
        respond,
      });
      expect(admitted.ok).toBe(allowed);
      if (!allowed) {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            message: expect.stringContaining("Session preparation changed"),
          }),
        );
      }
    } finally {
      if (admitted?.ok) {
        admitted.value.cleanupAdmittedRun();
      }
      clearAgentRunContext(runId);
    }
  });
});
