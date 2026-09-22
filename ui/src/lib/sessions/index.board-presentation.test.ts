// @vitest-environment node

import { describe, expect, it, onTestFinished } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsPatchResult } from "../../api/types.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const key = "agent:main:dashboard";
const sessionId = "dashboard-incarnation";
const initial: GatewaySessionRow = {
  key,
  agentId: "main",
  sessionId,
  kind: "direct",
  updatedAt: 10,
  boardFace: "dashboard",
  boardPresentation: "split",
  pinned: true,
  pinnedAt: 5,
  unread: true,
  lastReadAt: 1,
  lastActivityAt: 10,
};

function acknowledgement(
  presentation: GatewaySessionRow["boardPresentation"],
): SessionsPatchResult {
  return {
    ok: true,
    key,
    path: "(multiple)",
    entry: {
      sessionId,
      updatedAt: 20,
      ...(presentation ? { boardPresentation: presentation } : {}),
    },
  };
}

function createPresentationHarness(row = initial) {
  let current = row;
  let listFailure = false;
  const patchReply = createDeferred<SessionsPatchResult>();
  const request = createGatewayRequestMock(async (method) => {
    if (method === "sessions.list") {
      if (listFailure) {
        throw new Error("Roster refresh unavailable");
      }
      return sessionsResult([current], current.updatedAt ?? 0);
    }
    if (method === "sessions.patch") {
      return patchReply.promise;
    }
    if (method === "sessions.describe") {
      return { session: current };
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = createTestGatewayClient(request);
  const gateway = createGatewayHarness(client);
  const sessions = createTestSessionCapability(gateway.gateway);
  onTestFinished(() => {
    sessions.dispose();
    patchReply.resolve(acknowledgement("expanded"));
  });
  return {
    ...gateway,
    sessions,
    client,
    request,
    patchReply,
    setCurrent: (next: GatewaySessionRow) => {
      current = next;
    },
    failList: () => {
      listFailure = true;
    },
  };
}

describe("session capability dashboard default acknowledgements", () => {
  it("publishes acknowledged presentation to primary and dashboard lists without changing pin/read fields", async () => {
    const h = createPresentationHarness();
    const query = { agentId: "main", hasBoard: true, archivedFilter: "all" as const };
    await h.sessions.refresh({ agentId: "main", force: true });
    await h.sessions.refreshList({ ...query, force: true });
    const operation = h.sessions.patch(
      key,
      { boardPresentation: "expanded" },
      {
        agentId: "main",
        expectedSessionId: sessionId,
        deferListRefresh: true,
      },
    );
    expect(h.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(1);
    expect(h.sessions.state.result?.sessions[0]?.boardPresentation).toBe("split");
    expect(h.sessions.listSnapshot(query).result?.sessions[0]?.boardPresentation).toBe("split");
    expect(h.request).toHaveBeenCalledWith("sessions.patch", {
      key,
      agentId: "main",
      expectedSessionId: sessionId,
      boardPresentation: "expanded",
    });
    h.patchReply.resolve(acknowledgement("expanded"));
    await expect(operation).resolves.toMatchObject({ entry: { boardPresentation: "expanded" } });
    for (const result of [h.sessions.state.result, h.sessions.listSnapshot(query).result]) {
      expect(result?.sessions[0]).toMatchObject({
        sessionId,
        boardPresentation: "expanded",
        pinned: true,
        pinnedAt: 5,
        unread: true,
        lastReadAt: 1,
      });
    }
  });

  it("uses the acknowledged value rather than echoing the requested default", async () => {
    const h = createPresentationHarness({ ...initial, boardPresentation: "expanded" });
    await h.sessions.refresh({ agentId: "main", force: true });
    const operation = h.sessions.patch(
      key,
      { boardPresentation: "expanded" },
      {
        agentId: "main",
        expectedSessionId: sessionId,
        deferListRefresh: true,
      },
    );
    expect(h.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(1);
    h.patchReply.resolve(acknowledgement("split"));
    await operation;
    expect(h.sessions.state.result?.sessions[0]?.boardPresentation).toBe("split");
  });

  it("clears the optional default on a null patch instead of retaining an expanded cache value", async () => {
    const h = createPresentationHarness({ ...initial, boardPresentation: "expanded" });
    await h.sessions.refresh({ agentId: "main", force: true });
    const operation = h.sessions.patch(
      key,
      { boardPresentation: null },
      {
        agentId: "main",
        expectedSessionId: sessionId,
        deferListRefresh: true,
      },
    );
    expect(h.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(1);
    h.patchReply.resolve(acknowledgement(undefined));
    await operation;
    expect(h.sessions.state.result?.sessions[0]).not.toHaveProperty("boardPresentation");
    expect(h.sessions.state.result?.sessions[0]?.pinned).toBe(true);
  });

  it("retains the acknowledged default when the follow-up list fails and an older read arrives", async () => {
    const h = createPresentationHarness();
    await h.sessions.refresh({ agentId: "main", force: true });
    const reconcileEarlierRead = h.sessions.captureReconcile();
    const operation = h.sessions.patch(
      key,
      { boardPresentation: "expanded" },
      {
        agentId: "main",
        expectedSessionId: sessionId,
      },
    );
    expect(h.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(1);
    h.failList();
    h.patchReply.resolve(acknowledgement("expanded"));
    await expect(operation).resolves.toBeTruthy();
    expect(h.sessions.state.result?.sessions[0]?.boardPresentation).toBe("expanded");
    reconcileEarlierRead({ ...initial });
    expect(h.sessions.state.result?.sessions[0]?.boardPresentation).toBe("expanded");
  });

  it("keeps a newer external default ahead of an older successful patch acknowledgement", async () => {
    const h = createPresentationHarness();
    await h.sessions.refresh({ agentId: "main", force: true });
    const operation = h.sessions.patch(
      key,
      { boardPresentation: "expanded" },
      {
        agentId: "main",
        expectedSessionId: sessionId,
        deferListRefresh: true,
      },
    );
    expect(h.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(1);
    h.sessions.reconcileChanged({
      ...initial,
      sessionKey: key,
      reason: "patch",
      updatedAt: 30,
      boardPresentation: "split",
    });
    h.patchReply.resolve(acknowledgement("expanded"));
    await operation;
    expect(h.sessions.state.result?.sessions[0]).toMatchObject({
      sessionId,
      updatedAt: 30,
      boardPresentation: "split",
    });
  });

  it("does not attach an old incarnation's acknowledgement to a replacement row", async () => {
    const h = createPresentationHarness();
    await h.sessions.refresh({ agentId: "main", force: true });
    const operation = h.sessions.patch(
      key,
      { boardPresentation: "expanded" },
      {
        agentId: "main",
        expectedSessionId: sessionId,
        deferListRefresh: true,
      },
    );
    expect(h.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(1);
    const replacement = { ...initial, sessionId: "replacement-session", updatedAt: 30 };
    h.setCurrent(replacement);
    await h.sessions.refresh({ agentId: "main", force: true });
    h.patchReply.resolve(acknowledgement("expanded"));
    await operation;
    expect(h.sessions.state.result?.sessions[0]).toMatchObject({
      sessionId: replacement.sessionId,
      boardPresentation: "split",
    });
  });

  it("does not project a successful acknowledgement into a replacement Gateway", async () => {
    const h = createPresentationHarness();
    await h.sessions.refresh({ agentId: "main", force: true });
    const operation = h.sessions.patch(
      key,
      { boardPresentation: "expanded" },
      {
        agentId: "main",
        expectedSessionId: sessionId,
        deferListRefresh: true,
      },
    );
    expect(h.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(1);
    const replacement = { ...initial, sessionId: "other-gateway-session", updatedAt: 40 };
    const replacementClient = createTestGatewayClient((method) => {
      if (method === "sessions.list") {
        return sessionsResult([replacement], 40);
      }
      throw new Error(`Unexpected replacement Gateway request: ${method}`);
    });
    h.publish(false);
    h.publish(true, replacementClient);
    await h.sessions.refresh({ agentId: "main", force: true });
    h.patchReply.resolve(acknowledgement("expanded"));
    await operation;
    expect(h.sessions.state.result?.sessions[0]).toMatchObject({
      sessionId: "other-gateway-session",
      boardPresentation: "split",
    });
  });
});
