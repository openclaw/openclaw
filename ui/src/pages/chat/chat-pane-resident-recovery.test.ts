/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { loadChatHistory } from "./chat-history.ts";
import { nativeHistorySeq } from "./chat-pane-history.test-support.ts";
import { residentPane } from "./chat-pane-resident.test-support.ts";
import type { SidebarFullMessageLoader } from "./components/chat-sidebar-content-types.ts";
import { projectTranscriptRecovery } from "./components/chat-transcript-recovery.ts";
import { reduceChatSessionProjection } from "./history-merge.ts";

type FullResult = Awaited<ReturnType<SidebarFullMessageLoader>>;
const alive = (reference: WeakRef<object>) => reference.deref() !== undefined;

async function fixture(loader: SidebarFullMessageLoader) {
  const result = residentPane((messages) => {
    for (const message of messages) {
      const seq = nativeHistorySeq(message);
      if (seq === 601 || seq === 602) {
        Object.assign(message, {
          __openclaw: { id: `source-${seq}`, seq, truncated: true, runId: `run-${seq}` },
        });
      }
    }
  });
  await loadChatHistory(result.state, { deferBranches: true });
  const read = () =>
    result.pane.transcript.renderSession(result.state.sessionKey, (session) =>
      projectTranscriptRecovery(session.expandedAssistantMessages, {
        messages: result.state.chatMessages,
        toolMessages: [],
        sessionKey: result.state.sessionKey,
        loadFullAssistantMessage: loader,
      }),
    );
  result.pane.visuallyPresented = false;
  return { ...result, read };
}

it("releases hidden recovered bodies while the pane and another expansion stay alive", async () => {
  let retired!: {
    message: WeakRef<object>;
    content: WeakRef<object>;
    media: WeakRef<object>;
    control: WeakRef<object>;
  };
  let pinned!: WeakRef<object>;
  const { pane, state, read } = await fixture(async ({ messageId }) => {
    const media = {
      type: "image",
      source: { type: "base64", mediaType: "image/png", data: "c3ludGhldGlj" },
    };
    const content = [{ type: "text", text: `${messageId}: ${"x".repeat(64 * 1024)}` }, media];
    const message = { role: "assistant", content };
    if (messageId === "source-601") {
      retired = {
        message: new WeakRef(message),
        content: new WeakRef(content),
        media: new WeakRef(media),
        control: new WeakRef({}),
      };
    } else {
      pinned = new WeakRef(message);
    }
    return { ok: true, message };
  });
  reduceChatSessionProjection(state, {
    type: "runTerminal",
    runId: "run-602",
    status: "error",
    message: state.chatMessages.find((message) => nativeHistorySeq(message) === 602),
  });
  const recovery = read();
  recovery.expand("source-601");
  recovery.expand("source-602");
  await Promise.resolve();
  expect(recovery.get("source-601")?.status).toBe("loaded");
  await collectGarbageForTest();
  expect(alive(retired.control)).toBe(false);
  expect(alive(retired.content)).toBe(true);
  for (let page = 0; page < 6; page++) {
    await pane.loadOlderMessages(false);
  }
  expect(recovery.get("source-601") === undefined).toBe(true);
  expect(recovery.get("source-602")?.status).toBe("loaded");
  await collectGarbageForTest();
  expect(alive(retired.message)).toBe(false);
  expect(alive(retired.content)).toBe(false);
  expect(alive(retired.media)).toBe(false);
  expect(alive(pinned)).toBe(true);
  expect(pane.state).toBe(state);
});

it.each(["before", "after"])(
  "rejects an evicted pending expansion resolving %s re-admission",
  async (order) => {
    const retired = createDeferred<FullResult>();
    const current = createDeferred<FullResult>();
    let calls = 0;
    const { pane, read } = await fixture(() => (++calls === 1 ? retired.promise : current.promise));
    const previous = read();
    previous.expand("source-601");
    for (let page = 0; page < 6; page++) {
      await pane.loadOlderMessages(false);
    }
    expect(previous.get("source-601") === undefined).toBe(true);
    const resolveRetired = async () => {
      retired.resolve({ ok: true, message: { role: "assistant", content: "retired body" } });
      await retired.promise;
      await Promise.resolve();
    };
    if (order === "before") {
      await resolveRetired();
    }
    await pane.loadNewerMessages();
    await pane.loadNewerMessages();
    const next = read();
    next.expand("source-601");
    expect(calls).toBe(2);
    if (order === "after") {
      await resolveRetired();
    }
    expect(next.get("source-601")?.status).toBe("loading");
    current.resolve({ ok: true, message: { role: "assistant", content: "current body" } });
    await current.promise;
    await Promise.resolve();
    expect(next.get("source-601")).toMatchObject({ status: "loaded", markdown: "current body" });
  },
);
