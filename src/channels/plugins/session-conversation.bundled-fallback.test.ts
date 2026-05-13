import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";

const fallbackState = vi.hoisted(() => ({
  activeDirName: null as string | null,
  loadCalls: 0,
  resolveSessionConversation: null as
    | ((params: { kind: "group" | "channel"; rawId: string }) => {
        id: string;
        threadId?: string | null;
        baseConversationId?: string | null;
        parentConversationCandidates?: string[];
      } | null)
    | null,
}));

vi.mock("../../plugin-sdk/facade-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugin-sdk/facade-runtime.js")>(
    "../../plugin-sdk/facade-runtime.js",
  );
  return {
    ...actual,
    tryLoadActivatedBundledPluginPublicSurfaceModuleSync: ({ dirName }: { dirName: string }) => {
      fallbackState.loadCalls += 1;
      return dirName === fallbackState.activeDirName && fallbackState.resolveSessionConversation
        ? { resolveSessionConversation: fallbackState.resolveSessionConversation }
        : null;
    },
  };
});

import { resolveSessionConversation } from "./session-conversation.js";

type ResolveSessionConversation = NonNullable<typeof fallbackState.resolveSessionConversation>;

function enableBundledFallback(
  dirName: string,
  resolveSessionConversation: ResolveSessionConversation,
) {
  fallbackState.activeDirName = dirName;
  fallbackState.resolveSessionConversation = resolveSessionConversation;
  setRuntimeConfigSnapshot({
    plugins: {
      entries: {
        [dirName]: {
          enabled: true,
        },
      },
    },
  });
}

function enableThreadedFallback() {
  enableBundledFallback("mock-threaded", ({ rawId }) => {
    const [conversationId, threadId] = rawId.split(":topic:");
    return {
      id: conversationId,
      threadId,
      baseConversationId: conversationId,
      parentConversationCandidates: [conversationId],
    };
  });
}

describe("session conversation bundled fallback", () => {
  beforeEach(() => {
    fallbackState.activeDirName = null;
    fallbackState.loadCalls = 0;
    fallbackState.resolveSessionConversation = null;
    resetPluginRuntimeStateForTest();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("delegates pre-bootstrap thread parsing to the active bundled channel plugin", () => {
    enableThreadedFallback();

    expect(
      resolveSessionConversation({
        channel: "mock-threaded",
        kind: "group",
        rawId: "room:topic:42",
      }),
    ).toEqual({
      id: "room",
      threadId: "42",
      baseConversationId: "room",
      parentConversationCandidates: ["room"],
    });
  });

  it("can skip bundled fallback probing for hot generic-only callers", () => {
    enableThreadedFallback();

    expect(
      resolveSessionConversation({
        channel: "mock-threaded",
        kind: "group",
        rawId: "room:topic:42",
        bundledFallback: false,
      }),
    ).toEqual({
      id: "room:topic:42",
      threadId: undefined,
      baseConversationId: "room:topic:42",
      parentConversationCandidates: [],
    });
  });

  it("uses explicit bundled parent candidates before registry bootstrap", () => {
    enableBundledFallback("mock-parent", ({ rawId }) => ({
      id: rawId,
      baseConversationId: "room",
      parentConversationCandidates: ["room:topic:root", "room"],
    }));

    expect(
      resolveSessionConversation({
        channel: "mock-parent",
        kind: "group",
        rawId: "room:topic:root:sender:user",
      }),
    ).toEqual({
      id: "room:topic:root:sender:user",
      threadId: undefined,
      baseConversationId: "room",
      parentConversationCandidates: ["room:topic:root", "room"],
    });
  });

  it("delegates repeated fallback calls through the public-surface loader", () => {
    enableThreadedFallback();

    const firstRef = resolveSessionConversation({
      channel: "mock-threaded",
      kind: "group",
      rawId: "room:topic:42",
    });
    expect(firstRef?.id).toBe("room");
    expect(firstRef?.threadId).toBe("42");

    const secondRef = resolveSessionConversation({
      channel: "mock-threaded",
      kind: "group",
      rawId: "room:topic:43",
    });
    expect(secondRef?.id).toBe("room");
    expect(secondRef?.threadId).toBe("43");
    expect(fallbackState.loadCalls).toBe(2);
  });
});
