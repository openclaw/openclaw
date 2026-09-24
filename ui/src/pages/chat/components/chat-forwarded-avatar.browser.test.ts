import { html, nothing, render } from "lit";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import baseCss from "../../../styles/base.css?inline";
import groupedCss from "../../../styles/chat/grouped.css?inline";
import startupCss from "../../../styles/chat/startup-layout.css?inline";
import textCss from "../../../styles/chat/text.css?inline";

let container: HTMLElement;

afterEach(() => {
  render(nothing, container);
  container.remove();
});

it.each(
  [1440, 390].flatMap((width) => [
    { width, name: "legacy source", agentId: undefined, sessionKey: "legacy-checklist" },
    { width, name: "unlisted agent", agentId: "removed", sessionKey: "agent:removed:notes" },
    { width, name: "known agent", agentId: "research", sessionKey: "agent:research:notes" },
  ]),
)(
  "keeps forwarded identities and message alignment at $width px for $name",
  async ({ width, agentId, sessionKey }) => {
    await page.viewport(width, 1000);
    container = document.body.appendChild(document.createElement("section"));
    const makeGroup = (key: string, count: number, forwarded: boolean): MessageGroup => ({
      kind: "group",
      key,
      role: "assistant",
      timestamp: 1000,
      isStreaming: false,
      visibleContent: "text",
      ...(forwarded ? { senderSession: { sessionKey, agentId } } : {}),
      messages: Array.from({ length: count }, (_, index) => ({
        key: `${key}-${index}`,
        hasVisibleContent: true,
        message: {
          role: "assistant",
          content: [{ type: "text", text: `Checklist item ${index + 1}.` }],
        },
      })),
    });
    const normal = makeGroup("normal", 1, false);
    const single = makeGroup("single", 1, true);
    const grouped = makeGroup("grouped", 2, true);
    render(
      html`<style>
          ${baseCss}${startupCss}${groupedCss}${textCss}
        </style>
        ${[normal, single, grouped].map((group) =>
          renderMessageGroup(group, {
            agentId: "main",
            agents: [{ id: "main" }, { id: "research" }],
            assistantTextAvatar: "M",
            showReasoning: false,
          }),
        )}`,
      container,
    );
    const groups = [...container.querySelectorAll<HTMLElement>(".chat-group")];
    const normalGroup = groups[0]!;
    const reference = normalGroup.querySelector(".chat-group-messages")!.getBoundingClientRect();
    const expectedGutter = width === 1440 ? 46 : 0;
    expect(reference.x - normalGroup.getBoundingClientRect().x).toBeCloseTo(expectedGutter, 1);
    for (const group of groups.slice(1)) {
      const content = group.querySelector(".chat-group-messages")!.getBoundingClientRect();
      expect(content.x).toBeCloseTo(reference.x, 1);
      expect(content.width).toBeCloseTo(reference.width, 1);
      expect(content.x - group.getBoundingClientRect().x).toBeCloseTo(expectedGutter, 1);
      const hasAvatar = agentId === "research";
      const gutterAvatar = group.querySelector(":scope > .chat-avatar, :scope > .chat-avatar-slot");
      expect(Boolean(gutterAvatar)).toBe(hasAvatar);
      const attribution = group.querySelector(".chat-reply-attribution")!;
      const inlineAvatar = attribution.querySelector(".chat-reply-attribution__agent-avatar");
      expect(Boolean(inlineAvatar)).toBe(hasAvatar);
      if (agentId) {
        expect(attribution.textContent?.replace(/\s+/gu, " ").trim()).toBe(
          `From ${agentId} · ${sessionKey}`,
        );
        expect(attribution.querySelector("a")?.dataset.sessionKey).toBe(sessionKey);
        const from = attribution.children[1]!.getBoundingClientRect();
        const agent = attribution.querySelector(".chat-reply-attribution__agent")!;
        const name = agent.lastElementChild!.getBoundingClientRect();
        expect(name.x - from.right).toBeCloseTo(hasAvatar ? 6 + 18 + 4 : 6, 1);
        if (inlineAvatar) {
          expect(inlineAvatar.querySelector(".chat-avatar")).not.toBeNull();
        }
      } else {
        expect(attribution.textContent?.replace(/\s+/gu, " ").trim()).toBe("From legacy-checklist");
        expect(attribution.querySelector("a")).toBeNull();
      }
    }
    expect(groups[2]!.querySelectorAll(".chat-bubble")).toHaveLength(2);
  },
);
