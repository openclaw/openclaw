/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, expect, it } from "vitest";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { renderMessageGroup } from "./chat-message-group.ts";

let container: HTMLDivElement;
afterEach(() => {
  if (container) {
    render(null, container);
    container.remove();
  }
});

// Label rules: an agent's main session reads as the agent itself; other
// sessions read as the session (titler-resolved), prefixed with the agent
// name only when the sender is a different agent.
it.each(
  [
    {
      name: "another agent's main session labels as that agent",
      key: "agent:research:main",
      chipText: "Research Agent",
      prefix: null,
      titled: true,
    },
    {
      name: "own main session labels as the local agent",
      key: "agent:main:main",
      chipText: "main",
      prefix: null,
      titled: true,
    },
    {
      name: "same-agent session leaves the key for the titler",
      key: "agent:main:bench",
      chipText: "agent:main:bench",
      prefix: null,
      titled: false,
    },
    {
      name: "other-agent session prefixes the agent name",
      key: "agent:research:bench",
      chipText: "agent:research:bench",
      prefix: "Research Agent ·",
      titled: false,
    },
    {
      name: "same-agent subagent stays a subagent session",
      key: "agent:main:subagent:audit",
      chipText: "agent:main:subagent:audit",
      prefix: null,
      titled: false,
    },
    {
      name: "other-agent subagent stays a subagent session",
      key: "agent:research:subagent:audit",
      chipText: "agent:research:subagent:audit",
      prefix: null,
      titled: false,
    },
  ].flatMap((entry) => ["assistant", "user"].map((role) => Object.assign({ role }, entry))),
)("$role: $name", ({ key, chipText, prefix, titled, role }) => {
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
