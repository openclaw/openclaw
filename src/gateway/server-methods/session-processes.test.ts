import { afterEach, expect, it, vi } from "vitest";
import { addSession } from "../../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../../agents/bash-process-registry.test-support.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { sessionProcessHandlers } from "./session-processes.js";

afterEach(resetProcessRegistryForTests);

it.each([
  {
    role: "view" as const,
    scopes: ["operator.read", "operator.write"],
    own: false,
    allowed: false,
  },
  { role: "write" as const, scopes: ["operator.read"], own: false, allowed: false },
  {
    role: "write" as const,
    scopes: ["operator.read", "operator.write"],
    own: false,
    allowed: true,
  },
  {
    role: "write" as const,
    scopes: ["operator.read", "operator.sessions.write"],
    own: false,
    allowed: false,
  },
  {
    role: "write" as const,
    scopes: ["operator.read", "operator.sessions.write"],
    own: true,
    allowed: true,
  },
])(
  "projects and enforces process controls for $role with $scopes (own=$own)",
  async ({ role, scopes, own, allowed }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = rolePolicyConfig();
      await state.writeConfig(cfg);
      const owner = roleClient("write", "process-owner");
      const viewer = roleClient(role, "process-viewer");
      viewer.connect.scopes = scopes;
      const key = "agent:main:process-test";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        {
          sessionId: "session-process-test",
          updatedAt: 1,
          visibility: "shared",
          createdActor: {
            type: "human",
            source: "profile",
            id: (own ? viewer : owner).authenticatedUserProfile!.profileId,
          },
        },
      );
      const record = createProcessSessionFixture({ id: "visible-build", backgrounded: true });
      record.scopeKey = key;
      record.agentId = "main";
      record.processActivity = { resultSettled: false, lastOutputAtMs: record.startedAt };
      addSession(record);
      const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
      const dispatch = async (method: string, params: Record<string, unknown>) => {
        const respond = vi.fn();
        await handleGatewayRequest({
          req: { type: "req", id: method, method, params },
          context,
          client: viewer,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: sessionProcessHandlers,
        });
        return respond;
      };
      const listed = await dispatch("sessions.processes.list", { key });
      // A stale incarnation cannot stop any process, even when the viewer can control the session.
      const stopped = await dispatch("sessions.processes.stop", {
        key,
        sessionId: "session-process-test",
        processId: record.id,
        instanceId: "stale",
      });
      expect(stopped.mock.calls[0]?.[0]).toBe(allowed);
      if (allowed) {
        expect(stopped).toHaveBeenCalledWith(true, { requested: false });
      }
      expect(record.cancellationRequested).toBeUndefined();
      expect(listed).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          processes: [expect.objectContaining({ processId: record.id, canStop: allowed })],
        }),
      );
    });
  },
);

it("discards a remote process response after the request authority closes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:process-remote";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: key },
      { sessionId: "remote-session", updatedAt: 1 },
    );
    const reply = createDeferredCore<{ sessionId: string; processes: []; truncated: false }>();
    const started = createDeferredCore();
    let current = true;
    const context = await createHistoryReadContext();
    const placement = {
      state: "active",
      executionMode: "worker-turn",
      environmentId: "environment",
      activeOwnerEpoch: 1,
      generation: 1,
    };
    Object.assign(context, {
      workerSessionPlacementService: {
        prepareRuntimeRefresh: async () => ({ placement, assertCurrent() {}, release() {} }),
      },
      workerEnvironmentService: {
        observeProcesses: () => {
          started.resolve();
          return reply.promise;
        },
      },
    });
    const respond = vi.fn();
    const pending = sessionProcessHandlers["sessions.processes.list"]!({
      req: { type: "req", id: "read", method: "sessions.processes.list" },
      params: { key },
      context,
      client: null,
      respond,
      isWebchatConnect: () => false,
      hasCurrentClientAuthority: () => current,
    });
    await started.promise;
    current = false;
    reply.resolve({ sessionId: "remote-session", processes: [], truncated: false });
    await pending;
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    expect(respond.mock.calls.some(([ok]) => ok)).toBe(false);
  });
});
