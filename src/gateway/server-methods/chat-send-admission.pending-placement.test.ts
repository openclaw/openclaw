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
import * as sessionLifecycle from "../../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { stagePlacementTurnClaimWorkerPublication } from "../worker-environments/placement-turn-authority.js";
import { admitChatSend } from "./chat-send-admission.js";
import { prepareChatAdmission } from "./chat-send-admission.test-support.js";
import { expectRpcError } from "./rpc-response.test-support.js";

it.aroundEach((runTest) =>
  withOpenClawTestState({ label: "chat-admission" }, async () => {
    await loadOrCreateProcessDeviceIdentityAsync();
    await runTest();
  }),
);

const mainAgents = () => ({ ownership: "explicit" as const, entries: { main: {} } });
function seedSession(sessionKey: string, sessionId: string) {
  replaceSessionEntrySync({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });
}

function cleanupAdmission(
  admitted: Awaited<ReturnType<typeof admitChatSend>> | undefined,
  runId: string,
) {
  if (admitted?.ok) {
    admitted.value.cleanupAdmittedRun();
  }
  clearAgentRunContext(runId);
}

it.each(["restart", "stop"] as const)(
  "preserves client retry only when an unstarted chat admission is interrupted by %s",
  async (reason) => {
    const cfg: OpenClawConfig = { agents: mainAgents() };
    setRuntimeConfigSnapshot(cfg, cfg);
    const sessionKey = "agent:main:dashboard:pending-restart";
    const runId = "pending-restart-input";
    seedSession(sessionKey, "pending-restart-session");
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const { request, session } = await prepareChatAdmission({
      client: null,
      params: { sessionKey, message: "Keep this input", idempotencyKey: runId },
      context,
    });
    const target = {
      scope: session.storePath,
      identities: [sessionKey, session.backingSessionId],
    };
    const entered = createDeferred();
    const release = createDeferred();
    const blocker = sessionLifecycle.runSessionMutation({
      ...target,
      prepare: async () => {
        entered.resolve();
        await release.promise;
      },
      run: async () => {},
    });
    await entered.promise;
    const queued = createDeferred();
    const begin = sessionLifecycle.beginSessionEffect;
    using observation = vi.spyOn(sessionLifecycle, "beginSessionEffect");
    observation.mockImplementationOnce((params) => {
      const admission = begin(params);
      queued.resolve();
      return admission;
    });
    const respond = vi.fn();
    const params = { request, session, client: null, context, respond };
    const pending = admitChatSend(params);
    let retried: Awaited<ReturnType<typeof admitChatSend>> | undefined;
    try {
      await awaitGateBeforeSettlement(queued.promise, pending, "chat skipped pending admission");
      await sessionLifecycle.startSessionControllerInterruption({
        ...target,
        reason:
          reason === "restart"
            ? createAgentRunRestartAbortError()
            : createAgentRunDirectAbortError(),
      }).released;
      expect(await pending).toMatchObject({ ok: false });
      expect(rpcSourceTesting.has(runId)).toBe(false);
      expect(context.dedupe.has(session.pendingChatSendKey)).toBe(false);
      if (reason === "restart") {
        expectRpcError(respond, {
          code: "UNAVAILABLE",
          retryable: true,
          details: { reason: "gateway-restarting" },
        });
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
      cleanupAdmission(retried, runId);
    }
  },
);

it.each([
  // name, external, initially required, finally required, allowed, reload during read
  ["ineligible internal backend", false, false, false, true, false],
  ["required-profile external backend", true, true, true, true, false],
  ["local-to-required policy reload", true, false, true, true, false],
  ["local-to-required during placement preparation", true, false, true, true, true],
  ["required-to-local policy reload", true, true, false, false, false],
] as const)(
  "preserves pending placement fences for %s",
  async (_name, external, initialRequired, required, allowed, reloadDuringRead) => {
    let cfg: OpenClawConfig = {
      agents: mainAgents(),
      ...(initialRequired ? { cloudWorkers: { requiredProfile: "native" } } : {}),
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:backend-pending-placement",
      sessionId: "backend-pending-placement",
    };
    const runId = "backend-pending-placement-send";
    seedSession(scope.sessionKey, scope.sessionId);
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
    const { request, prepared, session } = await prepareChatAdmission({
      client,
      params: { sessionKey: scope.sessionKey, message: "Hello", idempotencyKey: runId },
      context,
      isDirectExternalUser: external,
    });
    expect(Boolean(prepared.restartSafeRequest)).toBe(external);
    const reloadPolicy = () => {
      cfg = { ...cfg, cloudWorkers: required ? { requiredProfile: "native" } : undefined };
      setRuntimeConfigSnapshot(cfg, cfg);
    };
    if (required !== initialRequired && !reloadDuringRead) {
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
    const reloadingRead = reloadDuringRead
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
      admitted = await admitChatSend({ request, session, client, context, respond });
      expect(admitted.ok, JSON.stringify(respond.mock.calls)).toBe(allowed);
      expect(rpcSourceTesting.has(runId)).toBe(allowed);
      if (!allowed) {
        expect(respond.mock.calls[0]?.[2]?.message).toContain("placement authority changed");
      }
      expect(() => read.current()).toThrow("placement authority changed");
    } finally {
      reloadingRead?.mockRestore();
      pending.rollback();
      read.release();
      cleanupAdmission(admitted, runId);
    }
  },
);

it.each<[name: string, patch: OpenClawConfig, allowed: boolean]>([
  [
    "unrelated plugin settings",
    { plugins: { entries: { "memory-core": { config: { dreaming: { enabled: true } } } } } },
    true,
  ],
  [
    "selected model",
    { agents: { ...mainAgents(), defaults: { model: { primary: "openai/changed" } } } },
    false,
  ],
  ["tool policy", { tools: { deny: ["exec"] } }, false],
  ["global plugin enablement", { plugins: { enabled: false } }, false],
  ["plugin allowlist", { plugins: { allow: ["memory-core"] } }, false],
  ["plugin denylist", { plugins: { deny: ["openai"] } }, false],
  ["harness enablement", { plugins: { entries: { codex: { enabled: false } } } }, false],
  ["plugin slot", { plugins: { slots: { contextEngine: "other" } } }, false],
])("rechecks prepared chat facts across a reload of %s", async (_name, patch, allowed) => {
  const cfg: OpenClawConfig = {
    agents: mainAgents(),
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
  seedSession(sessionKey, "reload-preparation-session");
  const context = createDirectChatContext({ getRuntimeConfig: () => currentConfig });
  const { request, session } = await prepareChatAdmission({
    client: null,
    params: { sessionKey, message: "Keep this turn", idempotencyKey: runId },
    context,
  });
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
    admitted = await admitChatSend({ request, session, client: null, context, respond });
    expect(admitted.ok).toBe(allowed);
    if (!allowed) {
      expectRpcError(respond, { message: expect.stringContaining("Session preparation changed") });
    }
  } finally {
    cleanupAdmission(admitted, runId);
  }
});
