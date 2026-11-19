import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import {
  resolveSessionConversationRef,
  resolveSessionParentSessionKey,
  resolveSessionThreadInfo,
} from "./session-conversation.js";
import type { ChannelMessagingAdapter } from "./types.core.js";

type Resolve = NonNullable<ChannelMessagingAdapter["resolveSessionConversation"]>;
const fallback = vi.hoisted(() => ({
  channel: "",
  calls: 0,
  resolve: undefined as Resolve | undefined,
}));
vi.mock("../../plugin-sdk/facade-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugin-sdk/facade-runtime.js")>()),
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync: ({ dirName }: { dirName: string }) => {
    fallback.calls++;
    return dirName === fallback.channel && fallback.resolve
      ? { resolveSessionConversation: fallback.resolve }
      : null;
  },
}));

function conversation(
  channel: string,
  rawId: string,
  id = rawId,
  threadId?: string,
  parents: string[] = [],
) {
  return {
    channel,
    kind: "group",
    rawId,
    id,
    threadId,
    baseSessionKey: `agent:main:${channel}:group:${id}`,
    baseConversationId: parents.at(-1) ?? id,
    parentConversationCandidates: parents,
  };
}
function loadChannel(id: string, messaging?: ChannelMessagingAdapter) {
  const plugin = { ...createChannelTestPluginBase({ id }), messaging };
  setActivePluginRegistry(createTestRegistry([{ pluginId: id, source: "test", plugin }]));
}
beforeEach(() => {
  resetPluginRuntimeStateForTest();
  fallback.channel = "";
  fallback.calls = 0;
  fallback.resolve = undefined;
});
afterEach(clearRuntimeConfigSnapshot);

describe("loaded channel session grammar", () => {
  beforeEach(() => setActivePluginRegistry(createSessionConversationTestRegistry()));
  const telegramKey = "agent:main:telegram:group:-100123:topic:77";
  it("lets Telegram own topic grammar and parent session keys", () => {
    expect(resolveSessionConversationRef(telegramKey)).toEqual(
      conversation("telegram", "-100123:topic:77", "-100123", "77", ["-100123"]),
    );
    expect(resolveSessionThreadInfo(telegramKey)).toEqual({
      baseSessionKey: "agent:main:telegram:group:-100123",
      threadId: "77",
    });
    expect(resolveSessionParentSessionKey(telegramKey)).toBe("agent:main:telegram:group:-100123");
  });
  it("does not load fallback for disabled plugins", () => {
    resetPluginRuntimeStateForTest();
    setRuntimeConfigSnapshot({ plugins: { entries: { telegram: { enabled: false } } } });
    expect(resolveSessionConversationRef(telegramKey)).toEqual(
      conversation("telegram", "-100123:topic:77"),
    );
    expect(fallback.calls).toBe(0);
  });
  it("lets Feishu own parent candidates without inventing a thread", () => {
    const rawId = "oc_group_chat:topic:om_topic_root:sender:ou_topic_user";
    const key = `agent:main:feishu:group:${rawId}`;
    expect(resolveSessionConversationRef(key)).toEqual(
      conversation("feishu", rawId, rawId, undefined, [
        "oc_group_chat:topic:om_topic_root",
        "oc_group_chat",
      ]),
    );
    expect(resolveSessionParentSessionKey(key)).toBeNull();
  });
});

const canonical = { id: "room:sender:user", baseConversationId: "base" };
const ordered = ["topic", "room"];
const untrimmed = [" topic ", "room", "topic", " "];
const inherited = { id: canonical.id, __proto__: { parentConversationCandidates: ordered } };
const withParents = (parentConversationCandidates: string[] | undefined) => ({
  ...canonical,
  parentConversationCandidates,
});
it.each([
  ["legacy only", null, ["room"], ["room"], "room"],
  ["explicit empty", withParents([]), ["legacy"], [], "base"],
  ["explicit undefined", withParents(undefined), ["legacy"], [], "base"],
  ["explicit ordered", withParents(untrimmed), ["legacy"], ordered, "room"],
  ["omitted", { id: canonical.id }, untrimmed, ordered, "room"],
  ["inherited with null legacy", inherited, null, ordered, "room"],
  ["inherited with empty legacy", inherited, [], [], "room"],
] satisfies [string, ReturnType<Resolve>, string[] | null, string[], string][])(
  "preserves parent precedence and result isolation: %s",
  (_name, resolved, legacy, parents, base) => {
    loadChannel("legacy-parent", {
      ...(resolved ? { resolveSessionConversation: () => resolved } : {}),
      resolveParentConversationCandidates: ({ rawId }) =>
        rawId.endsWith(":sender:user") ? legacy : null,
    });
    const key = "agent:main:legacy-parent:group:room:sender:user";
    const expected = {
      ...conversation("legacy-parent", canonical.id),
      baseConversationId: base,
      parentConversationCandidates: parents,
    };
    const first = resolveSessionConversationRef(key);
    expect(first).toEqual(expected);
    first?.parentConversationCandidates.push("caller-only");
    expect(resolveSessionConversationRef(key)).toEqual(expected);
  },
);

function enableFallback(channel: string, resolve: Resolve) {
  fallback.channel = channel;
  fallback.resolve = resolve;
  setRuntimeConfigSnapshot({ plugins: { entries: { [channel]: { enabled: true } } } });
}
function enableThreadedFallback() {
  enableFallback("mock-threaded", ({ rawId }) => {
    const [raw, threadId] = rawId.split(":topic:");
    const id = expectDefined(raw, "conversation id");
    return { id, threadId, baseConversationId: id, parentConversationCandidates: [id] };
  });
}
const key = "agent:main:mock-threaded:group:room:topic:42";
it("delegates repeated pre-bootstrap parsing through the public-surface loader", () => {
  enableThreadedFallback();
  expect(resolveSessionConversationRef(key)).toEqual(
    conversation("mock-threaded", "room:topic:42", "room", "42", ["room"]),
  );
  expect(resolveSessionConversationRef(key.replace("42", "43"))).toEqual(
    conversation("mock-threaded", "room:topic:43", "room", "43", ["room"]),
  );
  expect(fallback.calls).toBe(2);
});
it("keeps loaded plugins without messaging on generic thread grammar", () => {
  enableThreadedFallback();
  loadChannel("mock-threaded");
  expect(resolveSessionConversationRef(`${key}:thread:leaf`)).toEqual(
    conversation("mock-threaded", "room:topic:42:thread:leaf", "room:topic:42", "leaf", [
      "room:topic:42",
    ]),
  );
  expect(fallback.calls).toBe(0);
});
it("lets hot generic-only callers skip fallback", () => {
  enableThreadedFallback();
  expect(resolveSessionConversationRef(key, { bundledFallback: false })).toEqual(
    conversation("mock-threaded", "room:topic:42"),
  );
});
it("uses explicit bundled parent candidates before bootstrap", () => {
  const rawId = "room:topic:root:sender:user";
  enableFallback("mock-parent", ({ rawId: id }) => ({
    id,
    baseConversationId: "room",
    parentConversationCandidates: ["room:topic:root", "room"],
  }));
  expect(resolveSessionConversationRef(`agent:main:mock-parent:group:${rawId}`)).toEqual(
    conversation("mock-parent", rawId, rawId, undefined, ["room:topic:root", "room"]),
  );
});
