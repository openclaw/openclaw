import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { isSubagentRunQueued } from "../agents/subagents/registry/subagent-registry-read.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createActiveRun } from "./server-methods/chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./server-methods/sessions-abort.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import { useQueuedCollectorFixture } from "./session-utils.queued-collector.test-support.js";

const { createQueuedReservation, requestContext, launchedRunIds } = useQueuedCollectorFixture();

it.each(["active", "queued", "pending-chat", "agent"] as const)(
  "narrow collector Stop preserves a same-key prior-incarnation %s producer",
  async (kind) => {
    const client = roleClient("view", "collector-stop-owner");
    client.connId = "parent-requester";
    client.connect.scopes = ["operator.sessions.write"];
    const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
    setRuntimeConfigSnapshot(cfg);
    const { entry } = await createQueuedReservation("reserved", {
      actor: { type: "human", source: "profile", id: client.authenticatedUserProfile!.profileId },
    });
    expectDefined(
      loadGatewaySessionEntryReadOnly(entry.childSessionKey).entry,
      "collector session",
    );
    expect(loadGatewaySessionEntryReadOnly(entry.childSessionKey).entry?.createdActor).toEqual({
      type: "human",
      source: "profile",
      id: client.authenticatedUserProfile!.profileId,
    });
    const context = requestContext();
    const oldRunId = "prior-incarnation-input";
    const old = createActiveRun(entry.childSessionKey, {
      agentId: "main",
      sessionId: "previous-child-session",
      owner: { connId: client.connId },
    });
    if (kind === "active") {
      context.chatAbortControllers.set(oldRunId, old);
      context.chatRunState.getOrCreate(oldRunId).buffer = "untouched old partial";
    } else if (kind === "queued") {
      context.chatQueuedTurns.set(oldRunId, old);
    } else {
      context.dedupe.set(`${kind}:${oldRunId}`, {
        ts: Date.now(),
        ok: true,
        payload: {
          runId: oldRunId,
          status: "accepted",
          ownerConnId: client.connId,
          agentId: "main",
          sessionKey: entry.childSessionKey,
          sessionId: old.sessionId,
        },
      });
    }
    const originalPending = context.dedupe.get(`${kind}:${oldRunId}`);
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "collector-stop",
        method: "sessions.abort",
        params: { key: entry.childSessionKey },
      },
      context,
      client,
      respond,
      isWebchatConnect: () => false,
      extraHandlers: { "sessions.abort": sessionAbortHandlers["sessions.abort"]! },
    });
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[2]).toBeUndefined();
    expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
      true,
      { ok: true, status: "aborted", abortedRunId: entry.runId },
    ]);
    expect(isSubagentRunQueued(entry)).toBe(false);
    expect(entry.collectorCompletion?.status).toBe("killed");
    expect(old.controller.signal.aborted).toBe(false);
    if (kind === "active") {
      expect(context.chatAbortControllers.get(oldRunId)).toBe(old);
      expect(context.chatRunState.resolveBuffer(oldRunId, { final: true }).text).toBe(
        "untouched old partial",
      );
    } else if (kind === "queued") {
      expect(context.chatQueuedTurns.get(oldRunId)).toBe(old);
    } else {
      expect(context.dedupe.get(`${kind}:${oldRunId}`)).toBe(originalPending);
    }
    expect(launchedRunIds).toEqual([]);
  },
);
import "../agents/subagents/spawn/subagent-spawn-model.mocks.shared.js";
