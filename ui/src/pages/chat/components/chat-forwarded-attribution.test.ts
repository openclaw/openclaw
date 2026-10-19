/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { mountSolid as mountStatefulSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { ForwardedAttribution } from "./chat-forwarded-attribution.tsx";
import { MessageGroup as MessageGroupView } from "./chat-message-group-view.tsx";
import { ChatThread } from "./chat-thread-view.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

let container: HTMLDivElement;
afterEach(() => {
  cleanupSolid();
  container?.remove();
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
  mountStatefulSolid(
    MessageGroupView,
    {
      group,
      options: {
        showReasoning: false,
        showToolCalls: false,
        avatarPlacement: "none",
        agentId: "main",
        agents: [{ id: "main" }, { id: "research", identity: { name: "Research Agent" } }],
        mainKey: "main",
        senderAgentAvatars: new Map([["research", "blob:research-avatar"]]),
      },
    },
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

it("omits avatar space when the source agent is not in the roster", () => {
  container = document.body.appendChild(document.createElement("div"));
  mountStatefulSolid(
    ForwardedAttribution,
    {
      group: { senderSession: { sessionKey: "agent:research:main", label: "Research" } },
      options: { agentId: "main", mainKey: "main", agents: [{ id: "main" }] },
    },
    container,
  );
  expect(container.querySelector(".session-label")?.textContent).toBe("Research");
  expect(container.querySelector(".chat-reply-attribution__agent-avatar")).toBeNull();
});

it("routes forwarded cron runs with primary and keyboard activation, preserving native modified clicks", async ({
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
  onTestFinished(() => transcript.dispose());
  container = document.body.appendChild(document.createElement("div"));
  mountStatefulSolid(ChatThread, { props, transcript }, container);
  await waitForSolid(() =>
    expect(container.querySelector(".chat-reply-attribution a")).not.toBeNull(),
  );
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

it("keeps the titler's resolved label and title class when attribution counts update", () => {
  const group = { senderSession: { sessionKey: "agent:main:bench", agentId: "main" } };
  const options: Parameters<typeof ForwardedAttribution>[0]["options"] = {
    agentId: "main",
    mainKey: "main",
  };
  const view = mountStatefulSolid(ForwardedAttribution, { group, options });
  const link = view.container.querySelector<HTMLAnchorElement>("a.markdown-session-link")!;
  const label = link.querySelector(".session-label")!;
  label.textContent = "Resolved source title";
  link.classList.add("markdown-session-link--titled");

  view.update({ group, options: { ...options, updateCount: 2 } });

  expect(view.container.querySelector("a.markdown-session-link")).toBe(link);
  expect(label.textContent).toBe("Resolved source title");
  expect(link.classList.contains("markdown-session-link--titled")).toBe(true);
  expect(view.container.textContent).toContain("2 updates from");
});
