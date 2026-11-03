import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
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
const worktree = { id: "wt-1", branch: "openclaw/task", repoRoot: "/repo" };
const placement = (key: string, fields: Partial<GatewaySessionRow>) =>
  listed(key, { updatedAt: 2, worktree, ...fields }, 2);
const background = { reconciliation: "background" } as const;
const model = "openai/gpt-5.6-sol";
const thinkingEntry = (key: string, fields: Partial<GatewaySessionRow> = {}) => ({
  key,
  entry: { thinkingLevel: "xhigh", updatedAt: 1, ...fields },
});

async function createPrepared(
  sessions: ReturnType<typeof createTestSessionCapability>,
  key: string,
) {
  const created = vi.fn();
  sessions.subscribeCreated(created);
  await expect(
    sessions.createResult({ agentId: "main", model, worktree: true }, background),
  ).resolves.toMatchObject({ key });
  expect(created).toHaveBeenCalledExactlyOnceWith(key);
  expect(sessions.isPreparedWorkSession(key)).toBe(true);
  expect(sessions.state.modelOverrides[key]).toBe(model);
  return created;
}

function changed(key: string, fields: Partial<GatewaySessionRow>): GatewayEventFrame {
  return {
    type: "event",
    event: "sessions.changed",
    payload: { sessionKey: key, key, kind: "direct", ...fields },
  };
}

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

it.each(["current", "key-only", "cancelled", "replaced"])(
  "keeps creation failure attached to its request (%s)",
  async (outcome) => {
    const creation = createDeferred<unknown>();
    const error = new Error("synthetic creation refused");
    const controller = new AbortController();
    const { sessions, publish, request } = harness({
      "sessions.create": () => creation.promise,
    });
    const operation =
      outcome === "key-only"
        ? sessions.create({ agentId: "main" }, { signal: controller.signal })
        : sessions.createResult({ agentId: "main" }, { signal: controller.signal });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("sessions.create", expect.anything(), expect.anything()),
    );
    if (outcome === "cancelled") {
      controller.abort();
    } else if (outcome === "replaced") {
      publish(false);
    }
    creation.reject(error);
    if (outcome === "current") {
      await expect(operation).rejects.toBe(error);
    } else {
      await expect(operation).resolves.toBeNull();
    }
    expect(sessions.state.error).toBe(
      outcome === "current" || outcome === "key-only" ? error.message : null,
    );
    expect(request).not.toHaveBeenCalledWith("sessions.list", expect.anything());
  },
);

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
    const created = await createPrepared(sessions, key);
    const patch = sessions
      .patch(key, { model: claim === "newer" ? model : "openai/gpt-5-mini" })
      .catch((error: unknown) => error);
    if (claim === "failed-before-list") {
      pendingPatch.reject(new Error("model rejected"));
      expect(await patch).toEqual(new Error("model rejected"));
      expect(sessions.state.modelOverrides[key]).toBe(model);
    }

    pendingList.resolve(
      placement(key, {
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        modelOverrideSource: null,
      }),
    );
    await waitForFast(() => expect(sessions.isPreparedWorkSession(key)).toBe(false));
    if (claim === "failed-after-list") {
      expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-5-mini");
      pendingPatch.reject(new Error("model rejected"));
      expect(await patch).toEqual(new Error("model rejected"));
    }
    expect(created).toHaveBeenCalledOnce();
    expect(sessions.isPreparedWorkSession(key)).toBe(false);
    expect(sessions.state.modelOverrides[key]).toBe(claim === "newer" ? model : undefined);
    if (claim === "newer") {
      pendingPatch.resolve({ ok: true, key, entry: {} });
      await patch;
      expect(sessions.state.modelOverrides[key]).toBeUndefined();
    }
  },
);
it.each([{ updatedAt: 2 }, { sessionId: "created-session" }])(
  "reconciles created placement (%j)",
  async (event) => {
    const settleWithEvent = "updatedAt" in event;
    const pendingList = createDeferred<SessionsListResult>();
    const pendingAppendList = createDeferred<SessionsListResult>();
    const pendingCanonicalList = createDeferred<SessionsListResult>();
    const key = "agent:main:created-in-background";
    const { sessions, emitEvent } = harness({
      "sessions.create": () =>
        thinkingEntry(key, {
          sessionId: "created-session",
          modelProvider: "openai",
          model: "gpt-5.6-sol",
        }),
      "sessions.list": vi
        .fn()
        .mockReturnValueOnce(listed("agent:main:main", { updatedAt: 1 }, 1))
        .mockReturnValueOnce(pendingList.promise)
        .mockReturnValueOnce(
          settleWithEvent ? pendingCanonicalList.promise : pendingAppendList.promise,
        )
        .mockReturnValue(pendingCanonicalList.promise),
      "sessions.patch": () => {
        throw new Error("thinking rejected");
      },
    });
    await sessions.refresh({ force: true });
    const created = await createPrepared(sessions, key);
    expect(sessions.think(key)).toBe("xhigh");
    const stateChanged = vi.fn();
    sessions.subscribe(stateChanged);
    emitEvent(changed(key, { thinkingLevel: "medium", ...event }));
    expect(sessions.think(key)).toBe("medium");
    expect(stateChanged).toHaveBeenCalledOnce();

    pendingList.resolve(placement(key, { thinkingLevel: "xhigh" }));
    await waitForFast(() => expect(sessions.isPreparedWorkSession(key)).toBe(false));
    expect(sessions.think(key)).toBe("medium");
    await expect(sessions.patch(key, { thinkingLevel: "medium" })).rejects.toThrow(
      "thinking rejected",
    );
    expect(sessions.think(key)).toBe("medium");
    if (settleWithEvent) {
      emitEvent(changed(key, { thinkingLevel: "medium", updatedAt: 3 }));
      expect(sessions.think(key)).toBeUndefined();
    } else {
      const appendRefresh = sessions.refresh({ append: true, offset: 1, force: true });
      pendingAppendList.resolve(sessionsResult([], 3));
      await appendRefresh;
      expect(sessions.think(key)).toBe("medium");
    }
    const canonicalRefresh = sessions.refresh({ force: true });
    const canonicalThinkingLevel = settleWithEvent ? "medium" : "high";
    pendingCanonicalList.resolve(
      listed(key, { thinkingLevel: canonicalThinkingLevel, updatedAt: 3 }, 3),
    );
    await canonicalRefresh;
    expect(sessions.think(key)).toBeUndefined();
    expect(sessions.state.result?.sessions[0]?.thinkingLevel).toBe(canonicalThinkingLevel);
    expect(created).toHaveBeenCalledOnce();
    expect(sessions.isPreparedWorkSession(key)).toBe(false);
  },
);

it("clears a created thinking claim for an unversioned removal", async () => {
  const key = "agent:main:created-then-archived";
  const { sessions, emitEvent } = harness({
    "sessions.create": () => thinkingEntry(key),
    "sessions.list": () => listed(key, { thinkingLevel: "high", updatedAt: 0 }, 2),
  });
  await sessions.createResult({ agentId: "main" });
  expect(sessions.think(key)).toBe("xhigh");
  emitEvent(changed(key, { archived: true, thinkingLevel: "medium" }));
  expect(sessions.state.result?.sessions).toHaveLength(0);
  expect(sessions.think(key)).toBeUndefined();
});

it("isolates delayed raw-global thinking claims by agent", async () => {
  const pendingList = createDeferred<SessionsListResult>();
  const { sessions, gateway } = harness({
    "sessions.create": (params) =>
      thinkingEntry("global", {
        thinkingLevel: asOptionalRecord(params)?.agentId === "alpha" ? "xhigh" : "medium",
      }),
    "sessions.list": () => pendingList.promise,
  });
  gateway.snapshot.sessionKey = "global";

  await sessions.createResult({ agentId: "alpha" }, { reconciliation: "background" });
  await sessions.createResult({ agentId: "beta" }, { reconciliation: "background" });

  expect(sessions.think("global", "alpha")).toBe("xhigh");
  expect(sessions.think("global", "beta")).toBe("medium");
  expect(sessions.think("global", "main")).toBeUndefined();
});

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
});

it("retires a created thinking claim before replacement state is published", async () => {
  const key = "agent:main:created-before-reconnect";
  const { sessions, publish, request } = harness({
    "sessions.create": () => thinkingEntry(key),
    "sessions.list": () => listed(key, { thinkingLevel: "high", updatedAt: 0 }, 1),
    "sessions.subscribe": () => ({ subscribed: true }),
  });
  await sessions.createResult({ agentId: "main" });
  expect(sessions.think(key)).toBe("xhigh");
  const published: Array<string | undefined> = [];
  sessions.subscribe(() => published.push(sessions.think(key)));
  publish(true, createTestGatewayClient(request));
  expect(published[0]).toBeUndefined();
});
