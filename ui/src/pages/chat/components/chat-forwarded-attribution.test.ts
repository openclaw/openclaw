/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { ForwardedAttribution } from "./chat-forwarded-attribution.tsx";
import { MessageGroup as MessageGroupView } from "./chat-message-group-view.tsx";
import { createMessageGroup } from "./chat-message.test-support.ts";
import { ChatThread } from "./chat-thread-view.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

let container: HTMLDivElement;
const query = (selector: string) => container.querySelector(selector);
const options = { agentId: "main", mainKey: "main" };
const groupOptions = {
  ...options,
  showReasoning: false,
  showToolCalls: false,
  avatarPlacement: "none" as const,
  agents: [{ id: "main" }, { id: "research", identity: { name: "Research Agent" } }],
  senderAgentAvatars: new Map([["research", "blob:research-avatar"]]),
};
beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
});
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
  const group = createMessageGroup({ role, content: "report" }, role, {
    key: "forwarded",
    timestamp: 0,
    senderSession: { sessionKey: key, agentId: key.split(":")[1] },
  });
  mountSolid(MessageGroupView, { group, options: groupOptions }, container);

  const chip = query(`a.markdown-session-link[data-session-key="${key}"]`)!;
  expect(chip).not.toBeNull();
  expect(chip.textContent).toBe(chipText);
  expect(chip.querySelector(":scope > .session-label")?.textContent).toBe(chipText);
  expect(chip.classList.contains("markdown-session-link--titled")).toBe(titled);
  const attributionText = query(".chat-reply-attribution")
    ?.textContent?.replace(/\s+/g, " ")
    .trim();
  const avatar = query(".chat-reply-attribution img.chat-avatar");
  expect(avatar?.getAttribute("src") ?? null).toBe(
    key.startsWith("agent:research:") && !key.includes(":subagent:")
      ? "blob:research-avatar"
      : null,
  );
  expect(attributionText).toBe(`From ${prefix ? `${prefix} ` : ""}${chipText}`);
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
  mountSolid(ChatThread, { props, transcript }, container);
  await waitForSolid(() => expect(query(".chat-reply-attribution a")).not.toBeNull());
  const link = container.querySelector<HTMLAnchorElement>(".chat-reply-attribution a")!;
  expect(link).not.toBeNull();
  expect(link.getAttribute("href")).toBe("/control/automations?job=daily&run=first");
  link.focus();
  expect(document.activeElement).toBe(link);
  const eventOptions = { bubbles: true, cancelable: true };
  for (const event of [
    new MouseEvent("click", eventOptions),
    ...["Enter", " "].map((key) => new KeyboardEvent("keydown", { ...eventOptions, key })),
  ]) {
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("cron", { search: "?job=daily&run=first" });
    onNavigate.mockClear();
  }
  for (const init of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ]) {
    const event = new MouseEvent("click", { ...eventOptions, ...init });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(onNavigate).not.toHaveBeenCalled();
  expect(onOpenSessionLink).not.toHaveBeenCalled();
});

it("keeps the titler's resolved label and title class when attribution counts update", () => {
  const group = { senderSession: { sessionKey: "agent:main:bench", agentId: "main" } };
  const view = mountSolid(ForwardedAttribution, { group, options }, container);
  const link = query("a.markdown-session-link")!;
  const label = link.querySelector(".session-label")!;
  label.textContent = "Resolved source title";
  link.classList.add("markdown-session-link--titled");

  view.update({ group, options: { ...options, updateCount: 2 } });

  expect(query("a.markdown-session-link")).toBe(link);
  expect(label.textContent).toBe("Resolved source title");
  expect(link.classList.contains("markdown-session-link--titled")).toBe(true);
  expect(view.container.textContent).toContain("2 updates from");
});
