/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../../api/gateway.ts";
import { SessionLinkTitler } from "../../../components/session-link-titling.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { groupMessages } from "../chat-thread-grouping.ts";
import { renderMessageGroup } from "./chat-message.ts";

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
});

afterEach(async () => {
  await vi.dynamicImportSettled();
  render(null, container);
  vi.restoreAllMocks();
});

function createGroup(
  overrides: Partial<Pick<MessageGroup, "senderLabel" | "senderSession">> = {},
  messageOverrides: Record<string, unknown> = {},
): MessageGroup {
  const [group] = groupMessages([
    {
      kind: "message",
      key: "forwarded-message",
      message: {
        role: "assistant",
        content: "forwarded report",
        timestamp: 1_000,
        ...messageOverrides,
      },
    },
  ]);
  if (group?.kind !== "group") {
    throw new Error("expected a prepared assistant message group");
  }
  return { ...group, ...overrides };
}

function renderTestMessageGroup(
  group: MessageGroup,
  options: Partial<Parameters<typeof renderMessageGroup>[1]> = {},
) {
  return renderMessageGroup(group, {
    showReasoning: true,
    showToolCalls: true,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    ...options,
  });
}

describe("forwarded message attribution", () => {
  it("preserves custom assistant sender labels without forwarded provenance", () => {
    const group = createGroup({ senderLabel: "Forwarded from main" });

    render(renderTestMessageGroup(group), container);

    const sender = container.querySelector<HTMLElement>(".chat-group.assistant .chat-sender-name");
    expect(sender?.textContent).toBe("Forwarded from main");
    expect(container.querySelector(".chat-group--forwarded")).toBeNull();
  });

  it("keeps the source-session chip and timestamp/actions without a known sender avatar", () => {
    const group = createGroup({
      senderLabel: "Forwarded from main",
      senderSession: { sessionKey: "agent:main:main", agentId: "main" },
    });

    render(renderTestMessageGroup(group), container);

    const forwarded = container.querySelector<HTMLElement>(".chat-group--forwarded");
    expect(forwarded).not.toBeNull();
    expect(forwarded?.classList.contains("chat-group--sender-tint")).toBe(true);
    expect(forwarded?.style.getPropertyValue("--chat-sender-hue")).not.toBe("");
    const attribution = container.querySelector(".chat-group--forwarded .chat-reply-attribution");
    const link = attribution?.querySelector<HTMLAnchorElement>(
      'a.markdown-session-link[data-session-key="agent:main:main"]',
    );
    expect(attribution?.textContent).toContain("From");
    expect(link?.textContent).toBe("agent:main:main");
    expect(link?.tabIndex).toBe(0);
    expect(attribution?.nextElementSibling?.classList.contains("chat-bubble")).toBe(true);
    expect(container.querySelector(".chat-avatar, .chat-avatar-slot")).toBeNull();
    expect(container.querySelector(".chat-group-footer .chat-sender-name")).toBeNull();
    expect(container.querySelector(".chat-group-footer .chat-group-timestamp")).not.toBeNull();
    expect(container.querySelector(".chat-group-footer-actions")).not.toBeNull();
  });

  it.each([
    { agentId: "research", avatar: "blob:research-avatar", expected: "image" },
    { agentId: "research", avatar: null, expected: "face" },
    { agentId: "research", avatar: "https://example.test/avatar.png", expected: "face" },
    { agentId: "main", avatar: "blob:main-avatar", expected: "face" },
    { agentId: "removed", avatar: "blob:stale-avatar", expected: "empty" },
    { agentId: undefined, avatar: null, expected: "empty" },
  ])(
    "renders $expected for forwarded agent $agentId with $avatar",
    async ({ agentId, avatar, expected }) => {
      const group = createGroup({
        senderSession: { agentId },
      });
      const options = {
        agentId: "main",
        agents: [{ id: "main" }, { id: "research", identity: { name: "Research Agent" } }],
        senderAgentAvatars: new Map(agentId ? [[agentId, avatar]] : []),
      };
      render(renderTestMessageGroup(group, options), container);

      const image = container.querySelector("img.chat-avatar.assistant");
      expect(image !== null).toBe(expected === "image");
      if (expected === "empty") {
        expect(container.querySelector(".chat-avatar, .chat-avatar-slot")).toBeNull();
      }
      if (expected === "image") {
        expect(image?.getAttribute("src")).toBe(avatar);
        expect(image?.getAttribute("alt")).toBe("Research Agent");
      }
      if (expected === "face") {
        await vi.dynamicImportSettled();
        await vi.waitFor(() =>
          expect(container.querySelector(".identity-avatar__agent-face")).not.toBeNull(),
        );
        expect(container.querySelector(".chat-avatar--sender-initials")).toBeNull();
      }
    },
  );

  // Label rules: an agent's main session reads as the agent itself; other
  // sessions read as the session (titler-resolved), prefixed with the agent
  // name only when the sender is a different agent.
  it.each([
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
      name: "Gateway label overrides a main session's agent name",
      key: "agent:main:main",
      label: "Named source",
      chipText: "Named source",
      prefix: null,
      titled: true,
    },
    {
      name: "cron run uses its automation name",
      key: "agent:main:cron:daily:run:first",
      label: "Daily report",
      chipText: "Daily report",
      prefix: null,
      titled: true,
    },
    {
      name: "cron run without a label hides its raw session key",
      key: "agent:main:cron:daily:run:first",
      chipText: "Automation",
      prefix: null,
      titled: true,
    },
  ])("$name", async ({ key, label, chipText, prefix, titled }) => {
    const group = createGroup({
      senderSession: { sessionKey: key, agentId: key.split(":")[1], label },
    });
    render(
      renderTestMessageGroup(group, {
        agentId: "main",
        agents: [{ id: "main" }, { id: "research", identity: { name: "Research Agent" } }],
        mainKey: "main",
      }),
      container,
    );

    const chip = expectDefined(
      container.querySelector<HTMLAnchorElement>(
        `a.markdown-session-link[data-session-key="${key}"]`,
      ),
      "source session link",
    );
    expect(chip).toBeInstanceOf(HTMLAnchorElement);
    expect(chip.textContent?.trim()).toBe(chipText);
    expect(chip.querySelector(":scope > .session-label")?.textContent).toBe(chipText);
    expect(chip.classList.contains("markdown-session-link--titled")).toBe(titled);
    const attributionText =
      container
        .querySelector(".chat-group--forwarded .chat-reply-attribution")
        ?.textContent?.replace(/\s+/g, " ")
        .trim() ?? "";
    if (prefix) {
      expect(attributionText).toContain(prefix.replace(/\s+/g, " "));
    } else {
      expect(attributionText).not.toContain("—");
    }
    if (titled) {
      const titler = new SessionLinkTitler(container);
      titler.client = new GatewayBrowserClient({ url: "ws://localhost" });
      vi.spyOn(titler.client, "request").mockResolvedValueOnce({
        status: "ok",
        sessionKey: key,
        agentId: key.split(":")[1],
        title: "Client session title",
      });
      await titler.decorate(chip, true);
      expect(chip.textContent?.trim()).toBe(chipText);
      expect(chip.getAttribute("href")).toBe(
        key.includes(":cron:") ? "/chat/main/cron/daily/run/first" : `/chat/${key.split(":")[1]}`,
      );
    }
    if (key.includes(":cron:")) {
      expect(chip.querySelector(".session-link-icon svg")?.namespaceURI).toBe(
        "http://www.w3.org/2000/svg",
      );
    }
  });

  it.each([
    { senderSession: { agentId: "main" }, label: "Forwarded from main" },
    { senderSession: undefined, label: "Forwarded message" },
    // Non-agent-prefixed keys are not navigable (titler, hovercard, and click
    // handlers all reject them), so they stay readable plain text.
    { senderSession: { sessionKey: "legacy-session" }, label: "From legacy-session" },
  ])(
    "keeps legacy forwarded attribution visible without a session link: $label",
    ({ senderSession, label }) => {
      const group = createGroup(
        { senderSession },
        {
          content: "legacy report",
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        },
      );
      render(renderTestMessageGroup(group), container);

      expect(container.querySelector(".chat-group--forwarded")).not.toBeNull();
      const attribution = container.querySelector(".chat-group--forwarded .chat-reply-attribution");
      expect(attribution?.textContent?.replace(/\s+/g, " ").trim()).toBe(label);
      expect(attribution?.querySelector("a")).toBeNull();
      expect(attribution?.querySelector("[tabindex]")).toBeNull();
      expect(container.querySelector(".chat-group-footer .chat-sender-name")).toBeNull();
    },
  );

  // A rendered group's source cannot change in place: messages are immutable
  // and grouping splits on senderSession, so a different source produces a new
  // group key and a fresh anchor. The protected behavior is that the titler's
  // stamped title and href survive ordinary re-renders of the same group.
  it("keeps titled source chips usable across rerenders", async () => {
    const group = createGroup({
      senderSession: { sessionKey: "agent:main:main" },
    });
    const titler = new SessionLinkTitler(container);
    titler.client = new GatewayBrowserClient({ url: "ws://localhost" });
    vi.spyOn(titler.client, "request").mockResolvedValueOnce({
      status: "ok",
      sessionKey: "agent:main:main",
      agentId: "main",
      title: "Main session",
    });
    const sourceLink = () =>
      expectDefined(
        container.querySelector<HTMLAnchorElement>(
          ".chat-group--forwarded .chat-reply-attribution a",
        ),
        "source session link",
      );

    render(renderTestMessageGroup(group), container);
    expect(sourceLink()).toBeInstanceOf(HTMLAnchorElement);
    await titler.decorate(sourceLink(), true);
    expect(sourceLink().textContent).toBe("Main session");
    expect(() => render(renderTestMessageGroup(group), container)).not.toThrow();
    expect(sourceLink().textContent).toBe("Main session");
    expect(sourceLink().title).toBe("agent:main:main");
  });
});
