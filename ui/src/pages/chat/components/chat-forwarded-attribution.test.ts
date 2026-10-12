/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

let container: HTMLDivElement;
afterEach(() => {
  if (container) {
    render(null, container);
    container.remove();
  }
});

it.each([
  ["assistant", "agent:research:main", "Research Agent", null, true],
  ["user", "agent:main:main", "main", null, true],
  ["assistant", "agent:main:bench", "agent:main:bench", null, false],
  ["user", "agent:research:bench", "agent:research:bench", "Research Agent ·", false],
  ["assistant", "agent:main:subagent:audit", "agent:main:subagent:audit", null, false],
  ["user", "agent:research:subagent:audit", "agent:research:subagent:audit", null, false],
] as const)("labels %s forwarding from %s", (role, key, chipText, prefix, titled) => {
  container = document.createElement("div");
  const group: MessageGroup = {
    kind: "group",
    key: "forwarded",
    role,
    timestamp: 0,
    visibleContent: "text",
    isStreaming: false,
    messages: [
      {
        key: "forwarded-message",
        hasVisibleContent: true,
        message: { role, content: "forwarded report" },
      },
    ],
    senderSession: { sessionKey: key, agentId: key.split(":")[1] },
  };
  render(
    renderMessageGroup(group, {
      showReasoning: false,
      showToolCalls: false,
      avatarPlacement: "none",
      agentId: "main",
      agents: [{ id: "main" }, { id: "research", identity: { name: "Research Agent" } }],
      mainKey: "main",
      senderAgentAvatars: new Map([["research", "blob:research-avatar"]]),
    }),
    container,
  );

  const chip = container.querySelector<HTMLAnchorElement>(
    `a.markdown-session-link[data-session-key="${key}"]`,
  )!;
  expect(chip).not.toBeNull();
  expect(chip.textContent).toBe(chipText);
  expect(chip.querySelector(":scope > .session-label")?.textContent).toBe(chipText);
  expect(chip.classList.contains("markdown-session-link--titled")).toBe(titled);
  const attributionText =
    container.querySelector(".chat-reply-attribution")?.textContent?.replace(/\s+/g, " ").trim() ??
    "";
  const avatar = container.querySelector(".chat-reply-attribution img.chat-avatar");
  expect(avatar?.getAttribute("src") ?? null).toBe(
    key.startsWith("agent:research:") && !key.includes(":subagent:")
      ? "blob:research-avatar"
      : null,
  );
  expect(attributionText).toBe(`From ${prefix ? `${prefix} ` : ""}${chipText}`);
});

it("routes forwarded cron runs with primary and keyboard activation, preserving native modified clicks", ({
  onTestFinished,
}) => {
  installTranscriptDomMocks();
  onTestFinished(resetTranscriptTestDom);
  const onNavigate = vi.fn();
  const onOpenSessionLink = vi.fn();
  const props = {
    ...threadProps("pane-cron-run-link", "agent:main:main", [
      {
        role: "assistant",
        content: "Daily report",
        senderSession: {
          sessionKey: "agent:main:cron:daily:run:first",
          label: "Daily report",
        },
        timestamp: 1_000,
      },
    ]),
    basePath: "/control",
    onNavigate,
    onOpenSessionLink,
  };
  const transcript = createTestTranscript();
  onTestFinished(() => transcript.hostDisconnected());
  container = document.body.appendChild(document.createElement("div"));
  render(renderChatThread(props, transcript), container);
  const link = container.querySelector<HTMLAnchorElement>(".chat-reply-attribution a")!;
  expect(link).not.toBeNull();
  expect(link.getAttribute("href")).toBe("/control/automations?job=daily&run=first");
  link.focus();
  expect(document.activeElement).toBe(link);
  for (const event of [
    new MouseEvent("click", { bubbles: true, cancelable: true }),
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
  ]) {
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("cron", {
      search: "?job=daily&run=first",
    });
    onNavigate.mockClear();
  }
  for (const init of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ]) {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(onNavigate).not.toHaveBeenCalled();
  expect(onOpenSessionLink).not.toHaveBeenCalled();
});
