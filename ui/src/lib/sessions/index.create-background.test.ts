import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const listed = (key: string, fields: Partial<GatewaySessionRow>, ts: number) =>
  sessionsResult([{ key, kind: "direct", ...fields }], ts);

function harness(routes: Record<string, (params?: unknown) => unknown>) {
  const request = createGatewayRequestMock(async (method, params) => {
    const handler = routes[method];
    if (!handler) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return await handler(params);
  });
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  return { ...gateway, request, sessions: createTestSessionCapability(gateway.gateway) };
}

it.each(["newer", "failed-before-list", "failed-after-list"])(
  "reconciles created placement without retiring a newer model claim (%s)",
  async (claim) => {
    const pendingList = createDeferred<SessionsListResult>();
    const key = "agent:main:created-in-background";
    const pendingPatch = createDeferred<unknown>();
    const { sessions } = harness({
      "sessions.create": () => ({ key }),
      "sessions.list": () => pendingList.promise,
      "sessions.patch": () => pendingPatch.promise,
    });
    const created = vi.fn();
    sessions.subscribeCreated(created);

    await expect(
      sessions.createResult(
        { agentId: "main", model: "openai/gpt-5.6-sol", worktree: true },
        { reconciliation: "background" },
      ),
    ).resolves.toMatchObject({ key });
    expect(created).toHaveBeenCalledOnce();
    expect(created).toHaveBeenCalledWith(key);
    expect(sessions.isPreparedWorkSession(key)).toBe(true);
    expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-5.6-sol");
    const patch = sessions
      .patch(key, { model: claim === "newer" ? "openai/gpt-5.6-sol" : "openai/gpt-5-mini" })
      .catch((error: unknown) => error);
    if (claim === "failed-before-list") {
      pendingPatch.reject(new Error("model rejected"));
      expect(await patch).toEqual(new Error("model rejected"));
      expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-5.6-sol");
    }

    pendingList.resolve(
      listed(
        key,
        {
          updatedAt: 2,
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          modelOverrideSource: null,
          worktree: { id: "wt-1", branch: "openclaw/task", repoRoot: "/repo" },
        },
        2,
      ),
    );
    await waitForFast(() => expect(sessions.isPreparedWorkSession(key)).toBe(false));
    if (claim === "failed-after-list") {
      expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-5-mini");
      pendingPatch.reject(new Error("model rejected"));
      expect(await patch).toEqual(new Error("model rejected"));
    }
    expect(created).toHaveBeenCalledOnce();
    expect(sessions.isPreparedWorkSession(key)).toBe(false);
    expect(sessions.state.modelOverrides[key]).toBe(
      claim === "newer" ? "openai/gpt-5.6-sol" : undefined,
    );
    if (claim === "newer") {
      pendingPatch.resolve({ ok: true, key, entry: {} });
      await patch;
      expect(sessions.state.modelOverrides[key]).toBeUndefined();
    }
    sessions.dispose();
  },
);
it.each([
  {
    label: "versioned event",
    event: { thinkingLevel: "medium", updatedAt: 2 },
    settleWithEvent: true,
  },
  {
    label: "unversioned event",
    event: { sessionId: "created-session", thinkingLevel: "medium" },
    settleWithEvent: false,
  },
])("claims created placement through background reconciliation ($label)", async (testCase) => {
  const pendingList = createDeferred<SessionsListResult>();
  const pendingAppendList = createDeferred<SessionsListResult>();
  const pendingCanonicalList = createDeferred<SessionsListResult>();
  let listCalls = 0;
  const key = "agent:main:created-in-background";
  const { sessions, emitEvent } = harness({
    "sessions.create": () => ({
      key,
      entry: {
        sessionId: "created-session",
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        thinkingLevel: "xhigh",
        updatedAt: 1,
      },
    }),
    "sessions.list": () => {
      listCalls += 1;
      if (listCalls === 1) {
        return sessionsResult([{ key: "agent:main:main", kind: "direct", updatedAt: 1 }], 1);
      }
      if (listCalls === 2) {
        return pendingList.promise;
      }
      if (listCalls === 3 && !testCase.settleWithEvent) {
        return pendingAppendList.promise;
      }
      return pendingCanonicalList.promise;
    },
    "sessions.patch": () => {
      throw new Error("thinking rejected");
    },
  });
  const created = vi.fn();
  sessions.subscribeCreated(created);
  await sessions.refresh({ force: true });

  await expect(
    sessions.createResult(
      { agentId: "main", model: "openai/gpt-5.6-sol", worktree: true },
      { reconciliation: "background" },
    ),
  ).resolves.toMatchObject({ key });
  expect(created).toHaveBeenCalledOnce();
  expect(created).toHaveBeenCalledWith(key);
  expect(sessions.isPreparedWorkSession(key)).toBe(true);
  expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-5.6-sol");
  expect(sessions.think(key)).toBe("xhigh");
  const stateChanged = vi.fn();
  sessions.subscribe(stateChanged);
  emitEvent({
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey: key,
      key,
      kind: "direct",
      ...testCase.event,
    },
  });
  expect(sessions.think(key)).toBe("medium");
  expect(stateChanged).toHaveBeenCalledOnce();

  pendingList.resolve(
    listed(
      key,
      {
        thinkingLevel: "xhigh",
        updatedAt: 2,
        worktree: { id: "wt-1", branch: "openclaw/task", repoRoot: "/repo" },
      },
      2,
    ),
  );
  await waitForFast(() => expect(sessions.isPreparedWorkSession(key)).toBe(false));
  expect(sessions.think(key)).toBe("medium");
  await expect(sessions.patch(key, { thinkingLevel: "medium" })).rejects.toThrow(
    "thinking rejected",
  );
  expect(sessions.think(key)).toBe("medium");
  if (testCase.settleWithEvent) {
    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: key,
        key,
        kind: "direct",
        thinkingLevel: "medium",
        updatedAt: 3,
      },
    });
    expect(sessions.think(key)).toBeUndefined();
  } else {
    const appendRefresh = sessions.refresh({ append: true, offset: 1, force: true });
    pendingAppendList.resolve(sessionsResult([], 3));
    await appendRefresh;
    expect(sessions.think(key)).toBe("medium");
  }
  const canonicalRefresh = sessions.refresh({ force: true });
  const canonicalThinkingLevel = testCase.settleWithEvent ? "medium" : "high";
  pendingCanonicalList.resolve(
    listed(key, { thinkingLevel: canonicalThinkingLevel, updatedAt: 3 }, 3),
  );
  await canonicalRefresh;
  expect(sessions.think(key)).toBeUndefined();
  expect(sessions.state.result?.sessions[0]?.thinkingLevel).toBe(canonicalThinkingLevel);
  expect(created).toHaveBeenCalledOnce();
  expect(sessions.isPreparedWorkSession(key)).toBe(false);
  sessions.dispose();
});

it("clears a created thinking claim for an unversioned removal", async () => {
  const key = "agent:main:created-then-archived";
  const { sessions, emitEvent } = harness({
    "sessions.create": () => ({ key, entry: { thinkingLevel: "xhigh", updatedAt: 1 } }),
    "sessions.list": () => listed(key, { thinkingLevel: "high", updatedAt: 0 }, 2),
  });
  await sessions.createResult({ agentId: "main" });
  expect(sessions.think(key)).toBe("xhigh");
  emitEvent({
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey: key,
      key,
      kind: "direct",
      archived: true,
      thinkingLevel: "medium",
    },
  });
  expect(sessions.state.result?.sessions).toHaveLength(0);
  expect(sessions.think(key)).toBeUndefined();
  sessions.dispose();
});

it("isolates delayed raw-global thinking claims by agent", async () => {
  const pendingList = createDeferred<SessionsListResult>();
  const { sessions, gateway } = harness({
    "sessions.create": (params) => ({
      key: "global",
      entry: {
        thinkingLevel: asOptionalRecord(params)?.agentId === "alpha" ? "xhigh" : "medium",
        updatedAt: 1,
      },
    }),
    "sessions.list": () => pendingList.promise,
  });
  gateway.snapshot.sessionKey = "global";

  await sessions.createResult({ agentId: "alpha" }, { reconciliation: "background" });
  await sessions.createResult({ agentId: "beta" }, { reconciliation: "background" });

  expect(sessions.think("global", "alpha")).toBe("xhigh");
  expect(sessions.think("global", "beta")).toBe("medium");
  expect(sessions.think("global", "main")).toBeUndefined();
  sessions.dispose();
});

it.each(["success", "failure", "replaced"])(
  "keeps recovery notifications, errors and refresh scoped to the connection (%s)",
  async (outcome) => {
    const recovery = createDeferred<unknown>();
    const list = createDeferred<unknown>();
    const { sessions, publish, request } = harness({
      "sessions.recover": () => recovery.promise,
      "sessions.list": () => list.promise,
    });
    const created = vi.fn();
    sessions.subscribeCreated(created);
    const operation = sessions.recover({ key: "agent:main:expired", agentId: "main" });
    const successor = { ok: true, key: "agent:main:recovered", sessionId: "successor" };

    if (outcome === "replaced") {
      publish(false);
    }
    if (outcome === "failure") {
      recovery.reject(new Error("recovery rejected"));
    } else {
      recovery.resolve(successor);
    }
    if (outcome === "success") {
      await waitForFast(() => expect(created).toHaveBeenCalledWith(successor.key));
      expect(request).toHaveBeenCalledWith(
        "sessions.list",
        expect.objectContaining({ agentId: "main" }),
      );
      list.resolve(sessionsResult([{ key: successor.key, kind: "direct", updatedAt: 1 }], 1));
    }

    await expect(operation).resolves.toEqual(outcome === "success" ? successor : null);
    expect(sessions.state.error).toBe(outcome === "failure" ? "recovery rejected" : null);
    if (outcome === "failure" || outcome === "replaced") {
      expect(created).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalledWith("sessions.list", expect.anything());
    }
    sessions.dispose();
  },
);

it("retires prepared work placement when the session is deleted", async () => {
  const key = "agent:main:deleted-worktree";
  const { sessions } = harness({
    "sessions.create": () => ({ key }),
    "sessions.delete": () => ({ deleted: true }),
    "sessions.list": () => sessionsResult([], 2),
  });
  await expect(
    sessions.createResult({ agentId: "main", worktree: true }, { reconciliation: "background" }),
  ).resolves.toMatchObject({ key });
  expect(sessions.isPreparedWorkSession(key)).toBe(true);
  await expect(sessions.delete(key)).resolves.toMatchObject({ deleted: true });
  expect(sessions.isPreparedWorkSession(key)).toBe(false);
  sessions.dispose();
});

it("retires a created thinking claim before replacement state is published", async () => {
  const key = "agent:main:created-before-reconnect";
  const { sessions, publish, request } = harness({
    "sessions.create": () => ({ key, entry: { thinkingLevel: "xhigh", updatedAt: 1 } }),
    "sessions.list": () => listed(key, { thinkingLevel: "high", updatedAt: 0 }, 1),
    "sessions.subscribe": () => ({ subscribed: true }),
  });
  await sessions.createResult({ agentId: "main" });
  expect(sessions.think(key)).toBe("xhigh");
  const published: Array<string | undefined> = [];
  sessions.subscribe(() => published.push(sessions.think(key)));
  publish(true, createTestGatewayClient(request));
  expect(published[0]).toBeUndefined();
  sessions.dispose();
});
