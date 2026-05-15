import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "./types.js";

const storeState = vi.hoisted(() => ({
  stores: new Map<string, Record<string, SessionEntry>>(),
  resolveStorePathCalls: [] as Array<{ store?: string; opts?: { agentId?: string } }>,
}));

vi.mock("../io.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("./paths.js", () => ({
  resolveStorePath: (store?: string, opts?: { agentId?: string }) => {
    storeState.resolveStorePathCalls.push({ store, opts });
    return `/tmp/${opts?.agentId ?? "main"}-sessions.json`;
  },
}));

vi.mock("./store.js", () => ({
  loadSessionStore: (storePath: string) => storeState.stores.get(storePath) ?? {},
}));

let extractDeliveryInfo: typeof import("./delivery-info.js").extractDeliveryInfo;
let parseSessionThreadInfo: typeof import("./delivery-info.js").parseSessionThreadInfo;
let resolveSessionThreadIdForRouting: typeof import("./delivery-info.js").resolveSessionThreadIdForRouting;

const buildEntry = (deliveryContext: SessionEntry["deliveryContext"]): SessionEntry => ({
  sessionId: "session-1",
  updatedAt: Date.now(),
  deliveryContext,
});

const getStore = (agentId = "main"): Record<string, SessionEntry> => {
  const storePath = `/tmp/${agentId}-sessions.json`;
  let store = storeState.stores.get(storePath);
  if (!store) {
    store = {};
    storeState.stores.set(storePath, store);
  }
  return store;
};

beforeEach(async () => {
  vi.resetModules();
  storeState.stores.clear();
  storeState.resolveStorePathCalls = [];
  ({ extractDeliveryInfo, parseSessionThreadInfo, resolveSessionThreadIdForRouting } =
    await import("./delivery-info.js"));
});

beforeEach(() => {
  storeState.stores.clear();
  storeState.resolveStorePathCalls = [];
});

describe("extractDeliveryInfo", () => {
  it("parses base session and thread/topic ids", () => {
    expect(parseSessionThreadInfo("agent:main:telegram:group:1:topic:55")).toEqual({
      baseSessionKey: "agent:main:telegram:group:1",
      threadId: "55",
    });
    expect(
      parseSessionThreadInfo(
        "agent:main:feishu:group:oc_chat_123:topic:om_x100abc123:sender:ou_user_1",
      ),
    ).toEqual({
      baseSessionKey: "agent:main:feishu:group:oc_chat_123",
      threadId: "om_x100abc123",
    });
    expect(parseSessionThreadInfo("agent:main:slack:channel:C1:thread:123.456")).toEqual({
      baseSessionKey: "agent:main:slack:channel:C1",
      threadId: "123.456",
    });
    expect(
      parseSessionThreadInfo(
        "agent:main:matrix:channel:!room:example.org:thread:$AbC123:example.org",
      ),
    ).toEqual({
      baseSessionKey: "agent:main:matrix:channel:!room:example.org",
      threadId: "$AbC123:example.org",
    });
    expect(parseSessionThreadInfo("agent:main:telegram:dm:user-1")).toEqual({
      baseSessionKey: "agent:main:telegram:dm:user-1",
      threadId: undefined,
    });
    expect(parseSessionThreadInfo(undefined)).toEqual({
      baseSessionKey: undefined,
      threadId: undefined,
    });
  });

  it("returns deliveryContext for direct session keys", () => {
    const sessionKey = "agent:main:webchat:dm:user-123";
    getStore()[sessionKey] = buildEntry({
      channel: "webchat",
      to: "webchat:user-123",
      accountId: "default",
    });

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "webchat",
        to: "webchat:user-123",
        accountId: "default",
      },
      threadId: undefined,
    });
  });

  it("falls back to base sessions for :thread: keys", () => {
    const baseKey = "agent:main:slack:channel:C0123ABC";
    const threadKey = `${baseKey}:thread:1234567890.123456`;
    getStore()[baseKey] = buildEntry({
      channel: "slack",
      to: "slack:C0123ABC",
      accountId: "workspace-1",
    });

    const result = extractDeliveryInfo(threadKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "slack",
        to: "slack:C0123ABC",
        accountId: "workspace-1",
      },
      threadId: "1234567890.123456",
    });
  });

  it("falls back to base sessions for :topic: keys", () => {
    const baseKey = "agent:main:telegram:group:98765";
    const topicKey = `${baseKey}:topic:55`;
    getStore()[baseKey] = buildEntry({
      channel: "telegram",
      to: "group:98765",
      accountId: "main",
    });

    const result = extractDeliveryInfo(topicKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "group:98765",
        accountId: "main",
      },
      threadId: "55",
    });
  });

  it("loads thread delivery info from the named agent session store", () => {
    const baseKey = "agent:susan:slack:channel:C0123ABC";
    const threadKey = `${baseKey}:thread:1234567890.123456`;
    getStore("main")[baseKey] = buildEntry({
      channel: "slack",
      to: "slack:WRONG",
      accountId: "wrong-workspace",
    });
    getStore("susan")[baseKey] = buildEntry({
      channel: "slack",
      to: "slack:C0123ABC",
      accountId: "workspace-1",
    });

    const result = extractDeliveryInfo(threadKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "slack",
        to: "slack:C0123ABC",
        accountId: "workspace-1",
      },
      threadId: "1234567890.123456",
    });
    expect(storeState.resolveStorePathCalls.at(-1)).toEqual({
      store: undefined,
      opts: { agentId: "susan" },
    });
  });

  it("filters false-positive DM :thread: suffixes when resolving routing thread ids", () => {
    expect(
      resolveSessionThreadIdForRouting("agent:main:telegram:dm:user:thread:abc"),
    ).toBeUndefined();
    expect(
      resolveSessionThreadIdForRouting("agent:main:slack:dm:C0123ABC:thread:1234567890.123456"),
    ).toBe("1234567890.123456");
    expect(resolveSessionThreadIdForRouting("agent:main:telegram:group:1:topic:55")).toBe("55");
    expect(
      resolveSessionThreadIdForRouting("agent:main:mattermost:default:chan-1:thread:post-123"),
    ).toBe("post-123");
  });
});
