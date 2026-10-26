/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import type { SessionListSnapshot } from "../lib/sessions/session-capability.ts";
import { createContext, createGatewayHarness } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { observePersonActivityData, registerPersonActivityData } from "./person-activity-data.ts";

type Roster = SessionListSnapshot["result"];
function snapshot(
  result: Roster,
  error: string | null = null,
  readSucceeded = true,
): SessionListSnapshot {
  return { result, error, agentId: null, loading: false, readSucceeded };
}
function setup(client = createTestGatewayClient(async () => ({}))) {
  const gateway = createGatewayHarness(client);
  const sessions = createTestSessionCapability(gateway.gateway);
  return { gateway, sessions, context: createContext(gateway.gateway, sessions) };
}
function fixture() {
  const { gateway, sessions, context } = setup();
  const refresh = createDeferred();
  const dispose = vi.fn();
  let publish!: (snapshot: SessionListSnapshot) => void;
  const stale = sessionsResult([{ key: "agent:old:stale", kind: "direct" }], 1);
  const observe = vi.spyOn(sessions, "observeList").mockImplementation((_query, listener) => {
    publish = listener;
    listener(snapshot(stale));
    return { refresh: () => refresh.promise, dispose };
  });
  const changed = vi.fn();
  const activity = observePersonActivityData(context, changed);
  return {
    context,
    gateway,
    refresh,
    dispose,
    observe,
    changed,
    activity,
    publish: (result: Roster, error?: string, readSucceeded = true) =>
      publish(snapshot(result, error, readSucceeded)),
  };
}

it("keeps live and late-open cards current without a sidebar rendering publication", () => {
  const f = fixture();
  const context = f.context;
  const initial = { presence: [{ ts: 1, user: { id: "ada", name: "Ada" } }] };
  const data = { presencePayload: initial };
  const stopPublishing = registerPersonActivityData(context, data);
  const changed = vi.fn();
  const first = observePersonActivityData(context, changed);
  expect(first.data?.presencePayload).toBe(initial);
  const next = { presence: [{ ts: 2, user: { id: "ada", name: "Ada" }, host: "Second device" }] };
  data.presencePayload = next;
  f.gateway.publishEvent("presence", next);
  expect(changed).toHaveBeenCalledOnce();
  expect(first.data?.presencePayload).toEqual(next);
  const reopened = observePersonActivityData(context, () => undefined);
  expect(reopened.data?.presencePayload).toBe(next);
  first.dispose();
  reopened.dispose();
  const stopReplacement = registerPersonActivityData(context, { presencePayload: initial });
  stopPublishing();
  const replacement = observePersonActivityData(context, () => undefined);
  expect(replacement.data?.presencePayload).toBe(initial);
  replacement.dispose();
  stopReplacement();
  f.activity.dispose();
  context.sessions.dispose();
});

it.each([false, true])(
  "admits only fresh cross-agent membership (opening rejected=%s)",
  async (rejected) => {
    const f = fixture();
    const query = f.observe.mock.calls[0]![0];
    expect(query).toMatchObject({ limit: 200, rowMode: "compact", includeDerivedTitles: true });
    for (const key of ["agentId", "ownerId", "involvingMe", "search", "archivedFilter"]) {
      expect(query).not.toHaveProperty(key);
    }
    expect(f.activity.data?.sessionsResult).toBeNull();
    const result = sessionsResult([{ key: "agent:research:recent", kind: "direct" }], 2);
    f.publish(result);
    expect(f.activity.data?.sessionsResult).toBeNull();
    if (rejected) {
      f.refresh.reject(new Error("Unavailable"));
    } else {
      f.refresh.resolve();
    }
    await f.refresh.promise.catch(() => undefined);
    expect(f.activity.data?.sessionsResult).toBe(rejected ? null : result);
    if (rejected) {
      f.publish(result);
      expect(f.activity.data?.sessionsResult).toBe(result);
    }
    f.publish(null, "Temporarily unavailable");
    expect(f.activity.data?.sessionsResult).toBe(result);
    const empty = sessionsResult([], 3);
    f.publish(empty);
    expect(f.activity.data?.sessionsResult).toBe(empty);
    f.activity.dispose();
    expect(f.dispose).toHaveBeenCalledOnce();
  },
);

it.each(["close", "connection"] as const)(
  "ignores late data after %s retires the card",
  async (retire) => {
    const f = fixture();
    if (retire === "close") {
      f.activity.dispose();
    } else {
      f.gateway.publish({ phase: "reconnecting" });
    }
    f.publish(sessionsResult([{ key: "agent:main:late", kind: "direct" }], 2));
    f.refresh.resolve();
    await f.refresh.promise;
    expect(f.activity.data).toBeUndefined();
    expect(f.changed).not.toHaveBeenCalled();
    if (retire === "connection") {
      f.activity.dispose();
    }
  },
);

it("requires a successful-read receipt even when the managed refresh resolves without an error", async () => {
  const f = fixture();
  onTestFinished(() => f.activity.dispose());
  const result = sessionsResult([{ key: "agent:main:recovered", kind: "direct" }], 2);
  f.publish(result, undefined, false);
  f.refresh.resolve();
  await f.refresh.promise;
  expect(f.activity.data?.sessionsResult).toBeNull();
  f.publish(result);
  expect(f.activity.data?.sessionsResult).toBe(result);
});
