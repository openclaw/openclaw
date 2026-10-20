/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChatItems } from "../chat-thread-build.ts";
import { resetChatThreadState } from "../chat-thread.ts";
import { createMessageGroupHarness } from "./chat-message-native.test-support.tsx";
import { createReplyPreviewResolver } from "./chat-reply-preview.ts";
import { latestTranscriptAnnouncement } from "./chat-transcript-announcement.ts";
import {
  expandReplyTargetWork,
  projectTranscriptChain,
  projectTranscriptIndex,
} from "./chat-transcript-message-index.ts";

const sessionKey = "agent:main:dashboard:activity-preview";
const sourceKey = "agent:main:dashboard:icon-work";
const container = document.createElement("div");
const view = createMessageGroupHarness(container);

function update(id: string, source = sourceKey) {
  return {
    role: "assistant",
    content: "Original receipt " + id + ": " + "verification detail ".repeat(90) + "END " + id,
    timestamp: 1000,
    senderSession: { sessionKey: source, agentId: "main", label: "Visualize tool icons" },
    provenance: { kind: "inter_session", sourceTool: "sessions_send", sourceSessionKey: source },
    __openclaw: { id, runId: "run-" + id, turnBoundary: true },
  };
}
function chain(messages: unknown[], searchActive = false) {
  return projectTranscriptChain(
    buildChatItems({
      paneId: "activity-test",
      sessionKey,
      messages,
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    }),
    { sessionKey, runWorking: false, searchActive },
  );
}
function activityGroup(projection: ReturnType<typeof chain>, index = 0) {
  const group = projection.transcriptItems[index];
  if (group?.kind !== "group") {
    throw new Error("expected activity group");
  }
  return group;
}
function markers(projection: ReturnType<typeof chain>, expanded: Map<string, boolean>) {
  return projectTranscriptIndex(projection, expanded, { assistantName: "OpenClaw" }).positionIndex
    .markers;
}
function drawExpandable(group: ReturnType<typeof activityGroup>, assistantName?: string) {
  const expanded = new Map<string, boolean>();
  const draw = () =>
    view.render(group, {
      showReasoning: false,
      showToolCalls: false,
      assistantName,
      agentId: "main",
      isToolMessageExpanded: (id) => expanded.get(id),
      onToggleToolMessageExpanded: (id, previous) => {
        expanded.set(id, !previous);
        draw();
      },
    });
  draw();
  return { expanded, draw };
}
afterEach(() => {
  view.unmount();
  container.remove();
  resetChatThreadState();
});

function automation(id: string, jobId = "daily", source = sessionKey) {
  return {
    ...update(id, source),
    senderSession: { sessionKey: source, agentId: "main", label: "Daily report" },
    provenance: {
      kind: "internal_system",
      sourceTool: "cron",
      jobId,
      runId: id,
      sourceSessionKey: source,
    },
  };
}
function query<T extends HTMLElement = HTMLElement>(
  selector: string,
  root: ParentNode = container,
): T | null {
  return root.querySelector<T>(selector);
}

describe("session activity", () => {
  it("collapses recorded automation inputs and reveals their exact run from the shared disclosure", () => {
    const projection = chain([automation("execution")]);
    const { expanded, draw } = drawExpandable(activityGroup(projection));
    const disclosure = query<HTMLDetailsElement>(".chat-session-activity");
    expect(disclosure).toMatchObject({ open: false });
    expect(disclosure?.querySelector("summary")?.textContent).toContain("Daily report");
    expect(query("summary a[data-cron-run-link]", disclosure!)?.getAttribute("href")).toBe(
      "/automations?job=daily&run=execution",
    );
    expect(container.textContent).not.toContain("Original receipt");
    expect(query(".chat-avatar, .chat-group--forwarded, .chat-bubble")).toBeNull();
    expect(markers(projection, expanded)).toHaveLength(0);
    expect(latestTranscriptAnnouncement(projection.collapsedItems)?.text).toBe(
      "1 update from Daily report",
    );
    expandReplyTargetWork(projection.transcriptItems, expanded, "execution");
    draw();
    expect(disclosure).toMatchObject({ open: true });
    expect(container.textContent).toContain("END execution");
    expect(query("a[data-cron-run-link]", disclosure!)?.getAttribute("href")).toBe(
      "/automations?job=daily&run=execution",
    );
    expect(disclosure?.querySelector(".chat-message-disclosure__toggle")).toBeNull();
    expect(markers(projection, expanded)).toHaveLength(1);
  });
  it.each([
    { jobId: "other", runId: "execution" },
    { jobId: "daily", runId: "another-run" },
    { jobId: "daily", runId: "execution" },
  ])("never coalesces automation inputs sharing a session: %j", (identity) => {
    const first = automation("execution");
    const last = automation("next");
    last.provenance = { ...last.provenance, ...identity };
    // Old envelopes can lack the projection marker and share a session-incarnation run ID.
    const messages = [first, last].map((message) =>
      Object.assign({}, message, { __openclaw: { id: message["__openclaw"].id } }),
    );
    const projection = chain(messages);
    expect(projection.transcriptItems).toHaveLength(2);
    for (const [index, message] of messages.entries()) {
      expect(activityGroup(projection, index).messages.map((entry) => entry.message)).toEqual([
        message,
      ]);
    }
  });

  it.each([
    { kind: "internal_system", sourceTool: "cron" },
    { ...automation("execution").provenance, runId: 42 },
    { ...automation("execution").provenance, sourceTool: "hook" },
  ])("does not disguise incomplete or unrelated system input as automation: %j", (provenance) => {
    const group = activityGroup(chain([{ ...automation("input"), provenance }]));
    view.render(group, { showReasoning: false });
    expect(query(".chat-session-activity")).toBeNull();
  });

  it("folds adjacent same-source inputs without changing message order or reply identities", () => {
    const messages = [update("first"), update("second"), update("third")];
    const projection = chain(messages);
    expect(projection.transcriptItems).toHaveLength(1);
    const group = activityGroup(projection);
    expect(group.messages.map((entry) => entry.message)).toEqual(messages);
    expect(latestTranscriptAnnouncement(projection.collapsedItems)?.text).toBe(
      "3 updates from Visualize tool icons",
    );
    const expansions = new Map<string, boolean>();
    const index = projectTranscriptIndex(projection, expansions, { assistantName: "OpenClaw" });
    expect([...index.messageRowKeysById.values()]).toEqual([group.key, group.key, group.key]);
    expect(index.loadedReplySources.get("second")?.message).toBe(messages[1]);
    expect(index.positionIndex.markers).toHaveLength(0);
    expandReplyTargetWork(projection.transcriptItems, expansions, "second");
    expect(expansions.get("session-activity:" + group.key)).toBe(true);
    expect(markers(projection, expansions)).toHaveLength(1);
  });

  it.each([
    { role: "user", content: "A human intervened", timestamp: 1001 },
    { role: "assistant", content: "A local answer", timestamp: 1001 },
    update("other-source", "agent:main:dashboard:other"),
    {
      ...update("automation"),
      provenance: automation("run", "job", sourceKey).provenance,
    },
  ])(
    "never folds across a different source or visible conversation boundary: $role",
    (boundary) => {
      const projection = chain([update("first"), boundary, update("last")]);
      expect(projection.transcriptItems).toHaveLength(3);
    },
  );

  it("expands the full original messages in one disclosure and retains source navigation", () => {
    const { draw } = drawExpandable(
      activityGroup(chain([update("first"), update("second")])),
      "OpenClaw",
    );
    const disclosure = query<HTMLDetailsElement>(".chat-session-activity");
    const summary = disclosure?.querySelector("summary");
    if (!disclosure || !summary) {
      throw new Error("expected disclosure");
    }
    // Ignore renderer bookkeeping when checking the summary survives a toggle.
    const summaryMarkup = () => summary.innerHTML.replace(/<!--[^]*?-->/gu, "");
    const collapsedMarkup = summaryMarkup();
    expect(disclosure.open).toBe(false);
    expect(summary.textContent?.replace(/\s+/gu, " ").trim()).toBe(
      "2 updates from Visualize tool icons",
    );
    expect(container.textContent).not.toContain("Original receipt");
    expect(query(".chat-avatar, .chat-avatar-slot, .chat-group--forwarded")).toBeNull();
    expect(query("a[data-session-key]", summary)?.getAttribute("data-session-key")).toBe(sourceKey);
    disclosure.open = true;
    disclosure.dispatchEvent(new Event("toggle"));
    expect(disclosure.querySelectorAll(".chat-reply-attribution")).toHaveLength(1);
    expect(summaryMarkup()).toBe(collapsedMarkup);
    expect(query(".chat-session-activity__body .chat-reply-attribution", disclosure)).toBeNull();
    expect(container.textContent).toContain("END first");
    expect(container.textContent).toContain("END second");
    expect(query(".chat-message-disclosure__toggle")).toBeNull();
    expect(container.querySelectorAll(".chat-group-timestamp")).toHaveLength(2);
    draw();
    expect(disclosure.open).toBe(true);
    disclosure.open = false;
    disclosure.dispatchEvent(new Event("toggle"));
    expect(container.textContent).not.toContain("Original receipt");
  });

  it("retains a focused action while a same-key forwarded message refreshes", () => {
    const message = update("retained");
    const onReply = vi.fn();
    const draw = (content: string) => {
      view.render(activityGroup(chain([{ ...message, content }])), {
        showReasoning: false,
        isToolMessageExpanded: () => true,
        onReply,
      });
    };
    document.body.append(container);
    draw(message.content);
    const action = query<HTMLButtonElement>(".chat-group-footer-actions .chat-reply-btn");
    expect(action).not.toBeNull();
    action!.focus();
    expect(document.activeElement).toBe(action);
    draw("refreshed " + message.content);
    expect(container.textContent).toContain("refreshed");
    expect(query(".chat-group-footer-actions .chat-reply-btn")).toBe(action);
    expect(document.activeElement).toBe(action);
    action!.click();
    expect(onReply).toHaveBeenCalledOnce();
    expect(onReply.mock.calls[0]?.[0].text).toContain("refreshed");
  });

  it("keeps reply-bearing receipts separate and preserves navigation to their original", () => {
    const reply = update("reply");
    const messages = [
      update("first"),
      { ...reply, __openclaw: { ...reply["__openclaw"], replyToId: "older" } },
      update("last"),
    ];
    const projection = chain(messages);
    expect(projection.transcriptItems).toHaveLength(3);
    const group = activityGroup(projection, 1);
    const onOpenReply = vi.fn();
    const original = {
      message: {
        role: "user",
        content: "Earlier question",
        __openclaw: { id: "older", senderId: "alice", senderName: "Alice" },
      },
      messageId: "older-render",
      senderLabel: "Alice",
    };
    const resolveReplyPreview = createReplyPreviewResolver(new Map([["older", original]]), {
      assistantName: "Assistant",
    });
    view.render(group, {
      showReasoning: false,
      isToolMessageExpanded: () => true,
      resolveReplyPreview,
      onOpenReply,
    });
    const target = query<HTMLButtonElement>(
      '.chat-reply-attribution button[aria-label="Replying to Alice"]',
    );
    expect(target).not.toBeNull();
    target?.click();
    expect(onOpenReply).toHaveBeenCalledWith("older");
  });

  it("shows matching text immediately in transcript search", () => {
    const projection = chain([update("search")], true);
    const group = activityGroup(projection);
    view.render(group, {
      showReasoning: false,
      searchResult: true,
      isToolMessageExpanded: () => false,
    });
    expect(query(".chat-session-activity")).toMatchObject({ open: true });
    expect(container.textContent).toContain("END search");
    expect(container.querySelectorAll(".chat-reply-attribution")).toHaveLength(1);
    const sourceLink = query("summary a[data-session-key]");
    expect(sourceLink).not.toBeNull();
    const sourceClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    sourceLink?.dispatchEvent(sourceClick);
    expect(sourceClick.defaultPrevented).toBe(false);
    const collapsed = new Map([["session-activity:" + group.key, false]]);
    expect(
      projectTranscriptIndex(projection, collapsed, { assistantName: "Assistant" }).positionIndex
        .markers,
    ).toHaveLength(1);
    expect(collapsed.get("session-activity:" + group.key)).toBe(false);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    query("summary")?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });
});
