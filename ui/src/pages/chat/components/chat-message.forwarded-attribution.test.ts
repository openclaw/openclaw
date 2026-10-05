/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../../api/gateway.ts";
import {
  markdownFileLinkFromEvent,
  markdownFileLinkFromKeyboardEvent,
} from "../../../components/markdown-file-links.ts";
import { SessionLinkTitler } from "../../../components/session-link-titling.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { coalesceAgentRunFrames } from "../chat-agent-run-grouping.ts";
import { groupMessages } from "../chat-thread-grouping.ts";
import { renderAgentRunFrame } from "./chat-agent-run-frame.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import { createAssistantMessage, createMessageGroup } from "./chat-message.test-support.ts";

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
  return createMessageGroup(
    createAssistantMessage("forwarded report", { timestamp: 1_000, ...messageOverrides }),
    "assistant",
    overrides,
  );
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
  it.each([
    { collapsed: false, key: "click" },
    { collapsed: true, key: "Enter" },
    { collapsed: false, key: " " },
  ])(
    "resolves $key file links to the sender in collapsed=$collapsed groups",
    ({ collapsed, key }) => {
      const sessionKey = "agent:research:report";
      const group = createGroup(
        { senderSession: { sessionKey } },
        {
          content: "See `reports/index.html:7`",
          ...(collapsed
            ? { provenance: { kind: "inter_session", sourceTool: "sessions_send" } }
            : {}),
        },
      );
      render(renderTestMessageGroup(group, { isToolMessageExpanded: () => true }), container);
      const opened = vi.fn();
      container.addEventListener("click", (event) => opened(markdownFileLinkFromEvent(event)));
      container.addEventListener("keydown", (event) =>
        opened(markdownFileLinkFromKeyboardEvent(event)),
      );
      const link = expectDefined(
        container.querySelector<HTMLAnchorElement>("a.markdown-file-link"),
        "forwarded file link",
      );
      if (key === "click") {
        link.click();
      } else {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        link.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(opened).toHaveBeenCalledExactlyOnceWith({
        path: "reports/index.html",
        line: 7,
        sessionKey,
      });
    },
  );

  it.each([false, true])(
    "opens nested tool activity files in the sending session (frame=%s)",
    (frame) => {
      const sessionKey = "agent:research:report";
      const onOpenWorkspaceFile = vi.fn();
      const group = createGroup(
        { senderSession: { sessionKey } },
        {
          runId: "forwarded-tools",
          content: [
            {
              type: "toolCall",
              id: "parent-read",
              name: "read",
              arguments: { path: "reports/index.html" },
            },
            {
              type: "toolCall",
              id: "child-read",
              name: "read",
              parentToolCallId: "parent-read",
              arguments: { path: "reports/styles.css" },
            },
          ],
        },
      );
      const options = {
        showReasoning: true,
        onOpenWorkspaceFile,
        isToolMessageExpanded: () => true,
        isToolExpanded: () => true,
      };
      const content = frame
        ? renderAgentRunFrame(
            {
              kind: "agent-run-frame",
              key: "forwarded-frame",
              runId: "forwarded-tools",
              boundaryId: "forwarded-boundary",
              outcome: { kind: "completed", actionOwner: null },
              parts: [group],
            },
            {
              streamOptions: {},
              renderGroupOptions: () => options,
              isWorkExpanded: () => true,
              onToggleWork: () => {},
            },
          )
        : renderTestMessageGroup(group, options);
      render(content, container);
      const links = container.querySelectorAll<HTMLButtonElement>(".chat-tool-row__file-link");
      expect(links).toHaveLength(2);
      for (const link of links) {
        link.click();
      }
      expect(onOpenWorkspaceFile.mock.calls).toEqual([
        [{ path: "reports/index.html", sessionKey }],
        [{ path: "reports/styles.css", sessionKey }],
      ]);
    },
  );

  it("keeps the sender on narrated file links beside a single tool in a run frame", () => {
    const sessionKey = "agent:research:report";
    const groups = groupMessages([
      {
        kind: "message",
        key: "forwarded-tool-narration",
        message: {
          role: "assistant",
          runId: "narrated-file-run",
          timestamp: 1_000,
          senderSession: { sessionKey },
          content: [
            { type: "text", text: "See `reports/index.html:7`" },
            {
              type: "toolCall",
              id: "read-report",
              name: "read",
              arguments: { path: "reports/index.html" },
            },
          ],
        },
      },
      {
        kind: "message",
        key: "narrated-file-answer",
        message: {
          role: "assistant",
          runId: "narrated-file-run",
          timestamp: 2_000,
          phase: "final_answer",
          content: "Done.",
        },
      },
    ]).filter((item) => item.kind === "group");
    const frame = coalesceAgentRunFrames(groups).find((item) => item.kind === "agent-run-frame");
    if (!frame) {
      throw new Error("Expected the narrated tool to join its completed run frame");
    }
    render(
      renderAgentRunFrame(frame, {
        streamOptions: {},
        renderGroupOptions: () => ({ showReasoning: true }),
        isWorkExpanded: () => true,
        onToggleWork: () => {},
      }),
      container,
    );
    const opened = vi.fn();
    container.addEventListener("click", (event) => opened(markdownFileLinkFromEvent(event)));
    const link = expectDefined(
      container.querySelector<HTMLAnchorElement>('a[data-file-path="reports/index.html"]'),
      "narrated file link",
    );
    link.click();
    expect(opened).toHaveBeenCalledExactlyOnceWith({
      path: "reports/index.html",
      line: 7,
      sessionKey,
    });
  });

  it.each([false, true])(
    "preserves the sender footer or source chip (forwarded=%s)",
    async (forwarded) => {
      const group = createGroup({
        senderLabel: "Forwarded from main",
        ...(forwarded ? { senderSession: { sessionKey: "agent:main:main", agentId: "main" } } : {}),
      });
      render(renderTestMessageGroup(group), container);
      if (!forwarded) {
        expect(
          container.querySelector(".chat-group.assistant .chat-sender-name")?.textContent,
        ).toBe("Forwarded from main");
        expect(container.querySelector(".chat-group--forwarded")).toBeNull();
        return;
      }
      const forwardedGroup = container.querySelector<HTMLElement>(".chat-group--forwarded");
      expect(forwardedGroup).not.toBeNull();
      expect(forwardedGroup?.classList.contains("chat-group--sender-tint")).toBe(true);
      expect(forwardedGroup?.style.getPropertyValue("--chat-sender-hue")).not.toBe("");
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

      const titler = new SessionLinkTitler(container);
      titler.client = new GatewayBrowserClient({ url: "ws://localhost" });
      vi.spyOn(titler.client, "request").mockResolvedValueOnce({
        status: "ok",
        sessionKey: "agent:main:main",
        agentId: "main",
        title: "Main session",
      });
      const sourceLink = expectDefined(link, "source session link");
      expect(sourceLink).toBeInstanceOf(HTMLAnchorElement);
      await titler.decorate(sourceLink, true);
      expect(sourceLink.textContent).toBe("Main session");
      render(renderTestMessageGroup(group), container);
      const retained = container.querySelector<HTMLAnchorElement>(
        ".chat-group--forwarded .chat-reply-attribution a",
      );
      expect(retained?.textContent).toBe("Main session");
      expect(retained?.title).toBe("agent:main:main");
    },
  );

  it.each([
    { agentId: "research", avatar: "blob:research-avatar", expected: "image" },
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

  it.each([
    {
      name: "Gateway label overrides a main session's agent name",
      key: "agent:main:main",
      label: "Named source",
      chipText: "Named source",
      titled: true,
    },
    {
      name: "cron run uses its automation name",
      key: "agent:main:cron:daily:run:first",
      label: "Daily report",
      chipText: "Daily report",
      titled: true,
    },
    {
      name: "cron run respects the app base path and encodes its ids",
      key: "agent:main:cron:daily report:run:first+run",
      chipText: "Automation",
      titled: true,
      basePath: "/control",
      href: "/control/automations?job=daily+report&run=first%2Brun",
    },
  ])("$name", async ({ key, label, chipText, titled, basePath, href }) => {
    const group = createGroup({
      senderSession: { sessionKey: key, agentId: key.split(":")[1], label },
    });
    render(
      renderTestMessageGroup(group, {
        agentId: "main",
        agents: [{ id: "main" }, { id: "research", identity: { name: "Research Agent" } }],
        mainKey: "main",
        basePath,
      }),
      container,
    );

    const chip = expectDefined(
      container.querySelector<HTMLAnchorElement>("a.markdown-session-link"),
      "source session link",
    );
    expect(chip).toBeInstanceOf(HTMLAnchorElement);
    expect(chip.textContent?.trim()).toBe(chipText);
    expect(chip.querySelector(":scope > .session-label")?.textContent).toBe(chipText);
    expect(chip.classList.contains("markdown-session-link--titled")).toBe(titled);
    const isCronRun = key.includes(":cron:");
    expect(chip.getAttribute("data-session-key")).toBe(isCronRun ? null : key);
    const attributionText =
      container
        .querySelector(".chat-group--forwarded .chat-reply-attribution")
        ?.textContent?.replace(/\s+/g, " ")
        .trim() ?? "";
    expect(attributionText).not.toContain("—");
    if (titled) {
      const titler = new SessionLinkTitler(container);
      titler.client = new GatewayBrowserClient({ url: "ws://localhost" });
      const request = vi.spyOn(titler.client, "request").mockResolvedValueOnce({
        status: "ok",
        sessionKey: key,
        agentId: key.split(":")[1],
        title: "Client session title",
      });
      await titler.decorate(chip, true);
      expect(chip.textContent?.trim()).toBe(chipText);
      expect(chip.getAttribute("href")).toBe(
        isCronRun ? (href ?? "/automations?job=daily&run=first") : `/chat/${key.split(":")[1]}`,
      );
      if (isCronRun) {
        expect(request).not.toHaveBeenCalled();
      }
    }
    if (key.includes(":cron:")) {
      expect(chip.querySelector(".session-link-icon svg")?.namespaceURI).toBe(
        "http://www.w3.org/2000/svg",
      );
    }
  });

  it.each([
    { senderSession: { agentId: "main" }, label: "1 update · Forwarded from main" },
    { senderSession: undefined, label: "1 update · Forwarded message" },
    // Non-agent-prefixed keys are not navigable (titler, hovercard, and click
    // handlers all reject them), so they stay readable plain text.
    { senderSession: { sessionKey: "legacy-session" }, label: "1 update from legacy-session" },
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

      expect(container.querySelector(".chat-session-activity")).not.toBeNull();
      const attribution = container.querySelector(".chat-session-activity .chat-reply-attribution");
      expect(attribution?.textContent?.replace(/\s+/g, " ").trim()).toBe(label);
      expect(attribution?.querySelector("a")).toBeNull();
      expect(attribution?.querySelector("[tabindex]")).toBeNull();
      expect(container.querySelector(".chat-group-footer .chat-sender-name")).toBeNull();
    },
  );
});
