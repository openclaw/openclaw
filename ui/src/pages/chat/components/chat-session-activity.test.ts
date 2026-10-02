/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChatItems } from "../chat-thread-build.ts";
import { resetChatThreadState } from "../chat-thread.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import { createReplyPreviewResolver } from "./chat-reply-preview.ts";
import { latestTranscriptAnnouncement } from "./chat-transcript-announcement.ts";
import {
  expandReplyTargetWork,
  projectTranscriptChain,
  projectTranscriptIndex,
} from "./chat-transcript-message-index.ts";

const sessionKey = "agent:main:dashboard:activity-preview";
const sourceKey = "agent:main:dashboard:icon-work";
const options = { sessionKey, runWorking: false, searchActive: false };
const container = document.createElement("div");

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
    { ...options, searchActive },
  );
}
afterEach(() => {
  render(null, container);
  resetChatThreadState();
});

describe("inter-session activity", () => {
  it("folds adjacent same-source inputs without changing message order or reply identities", () => {
    const messages = [update("first"), update("second"), update("third")];
    const projection = chain(messages);
    expect(projection.transcriptItems).toHaveLength(1);
    const group = projection.transcriptItems[0];
    if (group?.kind !== "group") {
      throw new Error("expected activity group");
    }
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
    expect(expansions.get("inter-session:" + group.key)).toBe(true);
    expect(
      projectTranscriptIndex(projection, expansions, { assistantName: "OpenClaw" }).positionIndex
        .markers,
    ).toHaveLength(1);
  });

  it.each([
    { role: "user", content: "A human intervened", timestamp: 1001 },
    { role: "assistant", content: "A local answer", timestamp: 1001 },
    update("other-source", "agent:main:dashboard:other"),
    {
      ...update("automation"),
      provenance: {
        kind: "internal_system",
        sourceTool: "cron",
        jobId: "job",
        runId: "run",
        sourceSessionKey: sourceKey,
      },
    },
  ])(
    "never folds across a different source or visible conversation boundary: $role",
    (boundary) => {
      const projection = chain([update("first"), boundary, update("last")]);
      expect(projection.transcriptItems).toHaveLength(3);
    },
  );

  it("expands the full original messages in one disclosure and retains source navigation", () => {
    const group = chain([update("first"), update("second")]).transcriptItems[0];
    if (group?.kind !== "group") {
      throw new Error("expected activity group");
    }
    const expanded = new Map<string, boolean>();
    const draw = () =>
      render(
        renderMessageGroup(group, {
          showReasoning: false,
          showToolCalls: false,
          assistantName: "OpenClaw",
          agentId: "main",
          isToolMessageExpanded: (id) => expanded.get(id),
          onToggleToolMessageExpanded: (id, previous) => {
            expanded.set(id, !previous);
            draw();
          },
        }),
        container,
      );
    draw();
    const disclosure = container.querySelector<HTMLDetailsElement>(".chat-session-activity");
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.querySelector("summary")?.textContent).toContain("2 updates from");
    expect(disclosure?.querySelector("summary")?.textContent).toContain("Visualize tool icons");
    expect(container.textContent).not.toContain("Original receipt");
    expect(
      container.querySelector(".chat-avatar, .chat-avatar-slot, .chat-group--forwarded"),
    ).toBeNull();
    expect(disclosure?.querySelector("summary a")).toBeNull();
    if (!disclosure) {
      throw new Error("expected disclosure");
    }
    disclosure.open = true;
    disclosure.dispatchEvent(new Event("toggle"));
    expect(disclosure.querySelector("a[data-session-key]")?.getAttribute("data-session-key")).toBe(
      sourceKey,
    );
    expect(container.textContent).toContain("END first");
    expect(container.textContent).toContain("END second");
    // File links in relayed messages resolve against the sender's workspace.
    expect(
      container.querySelector<HTMLElement>("[data-file-session-key]")?.dataset.fileSessionKey,
    ).toBe(sourceKey);
    expect(container.querySelector(".chat-message-disclosure__toggle")).toBeNull();
    expect(container.querySelectorAll(".chat-group-timestamp")).toHaveLength(2);
    draw();
    expect(disclosure.open).toBe(true);
    disclosure.open = false;
    disclosure.dispatchEvent(new Event("toggle"));
    expect(container.textContent).not.toContain("Original receipt");
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
    const group = projection.transcriptItems[1];
    if (group?.kind !== "group") {
      throw new Error("expected reply activity group");
    }
    const onOpenReply = vi.fn();
    const resolveReplyPreview = createReplyPreviewResolver(
      new Map([
        [
          "older",
          {
            message: {
              role: "user",
              content: "Earlier question",
              __openclaw: { id: "older", senderId: "alice", senderName: "Alice" },
            },
            messageId: "older-render",
            senderLabel: "Alice",
          },
        ],
      ]),
      { assistantName: "Assistant" },
    );
    render(
      renderMessageGroup(group, {
        showReasoning: false,
        isToolMessageExpanded: () => true,
        resolveReplyPreview,
        onOpenReply,
      }),
      container,
    );
    const target = container.querySelector<HTMLButtonElement>(
      '.chat-reply-attribution button[aria-label="Replying to Alice"]',
    );
    expect(target).not.toBeNull();
    target?.click();
    expect(onOpenReply).toHaveBeenCalledWith("older");
  });

  it("shows matching text immediately in transcript search", () => {
    const projection = chain([update("search")], true);
    const group = projection.transcriptItems[0];
    if (group?.kind !== "group") {
      throw new Error("expected search group");
    }
    render(
      renderMessageGroup(group, {
        showReasoning: false,
        searchResult: true,
        isToolMessageExpanded: () => false,
      }),
      container,
    );
    expect(container.querySelector<HTMLDetailsElement>(".chat-session-activity")?.open).toBe(true);
    expect(container.textContent).toContain("END search");
    const collapsed = new Map([["inter-session:" + group.key, false]]);
    expect(
      projectTranscriptIndex(projection, collapsed, { assistantName: "Assistant" }).positionIndex
        .markers,
    ).toHaveLength(1);
    expect(collapsed.get("inter-session:" + group.key)).toBe(false);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    container.querySelector("summary")?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });
});
