import { afterEach, expect, it, vi } from "vitest";
import { addSession } from "../../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../../agents/bash-process-registry.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { sessionProcessHandlers } from "./session-processes.js";

afterEach(resetProcessRegistryForTests);
const stateOptions = { scenario: "minimal", prepareProfileCatalog: true } as const;

it.each([
  ["view", "operator.write", false, false],
  ["write", undefined, false, false],
  ["write", "operator.write", false, true],
  ["write", "operator.sessions.write", false, false],
  ["write", "operator.sessions.write", true, true],
] as const)(
  "projects and enforces process controls for %s with %s (own=%s, allowed=%s)",
  async (role, writeScope, own, allowed) => {
    await withOpenClawTestState(stateOptions, async (state) => {
      const cfg = rolePolicyConfig();
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const owner = roleClient("write", "process-owner");
      const viewer = roleClient(role, "process-viewer");
      viewer.connect.scopes = ["operator.read", ...(writeScope ? [writeScope] : [])];
      const key = "agent:main:process-test";
      const ownerId = (own ? viewer : owner).authenticatedUserProfile!.profileId;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        {
          sessionId: "session-process-test",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: ownerId },
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
      const process = expect.objectContaining({ processId: record.id, canStop: allowed });
      expect(listed).toHaveBeenCalledWith(true, expect.objectContaining({ processes: [process] }));
    });
  },
);

it("discards a remote process response after the request authority closes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
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
