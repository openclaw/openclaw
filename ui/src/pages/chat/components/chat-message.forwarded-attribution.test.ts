/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../../api/gateway.ts";
import {
  markdownFileLinkFromEvent,
  markdownFileLinkFromKeyboardEvent,
} from "../../../components/markdown-file-links.ts";
import { SessionLinkTitler } from "../../../components/session-link-titling.ts";
import { SESSION_TITLE_TARGET_SELECTOR } from "../../../components/session-progress-hovercard-target.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { coalesceAgentRunFrames } from "../chat-agent-run-grouping.ts";
import { groupMessages } from "../chat-thread-grouping.ts";
import { AgentRunFrame } from "./chat-agent-run-frame.tsx";
import type { NativeMessageGroupOptions } from "./chat-message-group-view.tsx";
import { createMessageGroupHarness } from "./chat-message-native.test-support.tsx";
import { createAssistantMessage, createMessageGroup } from "./chat-message.test-support.ts";
import { createReplyPreviewResolver, type LoadedReplySource } from "./chat-reply-preview.ts";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";
import { projectTranscriptChain, projectTranscriptIndex } from "./chat-transcript-message-index.ts";

let container: HTMLDivElement;
let view: ReturnType<typeof createMessageGroupHarness>;
const query = (selector: string) => container.querySelector<HTMLElement>(selector);
const required = (selector: string) => expectDefined(query(selector), selector);
const text = (selector: string) => query(selector)?.textContent;
const sessionKey = "agent:research:report";
const agentOptions = {
  agentId: "main",
  agents: [{ id: "main" }, { id: "research", identity: { name: "Research Agent" } }],
};
const runOptions = (renderGroupOptions: () => NativeMessageGroupOptions) => ({
  streamOptions: {},
  renderGroupOptions,
  isWorkExpanded: () => true,
  onToggleWork: () => {},
});

beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
  view = createMessageGroupHarness(container);
});

afterEach(async () => {
  await vi.dynamicImportSettled();
  view.unmount();
  cleanupSolid();
  container.remove();
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
  options: Partial<NativeMessageGroupOptions> = {},
) {
  return view.render(group, {
    showReasoning: true,
    showToolCalls: true,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    ...options,
  });
}

function titlerFor(key: string, title: string) {
  const titler = new SessionLinkTitler();
  titler.client = new GatewayBrowserClient({ url: "ws://localhost" });
  const request = vi.spyOn(titler.client, "request").mockResolvedValueOnce({
    status: "ok",
    sessionKey: key,
    agentId: key.split(":")[1],
    title,
  });
  for (const target of container.querySelectorAll<HTMLElement>(SESSION_TITLE_TARGET_SELECTOR)) {
    titler.register(
      target,
      target.querySelector<HTMLElement>(".session-label") ?? document.createElement("span"),
    );
  }
  return { titler, request };
}

function readCall(id: string, path: string, parentToolCallId?: string) {
  return {
    type: "toolCall",
    id,
    name: "read",
    arguments: { path },
    ...(parentToolCallId ? { parentToolCallId } : {}),
  };
}

function narrationEntry(key: string, content: unknown, overrides: Record<string, unknown>) {
  return {
    kind: "message" as const,
    key,
    message: createAssistantMessage(content, {
      runId: "narrated-file-run",
      ...overrides,
    }),
  };
}

describe("forwarded message attribution", () => {
  it.each([
    { collapsed: false, key: "click" },
    { collapsed: true, key: "Enter" },
    { collapsed: false, key: " " },
  ])(
    "resolves $key file links to the sender in collapsed=$collapsed groups",
    ({ collapsed, key }) => {
      const group = createGroup(
        { senderSession: { sessionKey } },
        {
          content: "See `reports/index.html:7`",
          ...(collapsed
            ? { provenance: { kind: "inter_session", sourceTool: "sessions_send" } }
            : {}),
        },
      );
      renderTestMessageGroup(group, { isToolMessageExpanded: () => true });
      const opened = vi.fn();
      container.addEventListener("click", (event) => opened(markdownFileLinkFromEvent(event)));
      container.addEventListener("keydown", (event) =>
        opened(markdownFileLinkFromKeyboardEvent(event)),
      );
      const link = required("a.markdown-file-link");
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
    async (frame) => {
      const onOpenWorkspaceFile = vi.fn();
      const group = createGroup(
        { senderSession: { sessionKey } },
        {
          runId: "forwarded-tools",
          content: [
            readCall("parent-read", "reports/index.html"),
            readCall("child-read", "reports/styles.css", "parent-read"),
          ],
        },
      );
      const options = {
        showReasoning: true,
        onOpenWorkspaceFile,
        isToolMessageExpanded: () => true,
        isToolExpanded: () => true,
      };
      if (frame) {
        mountSolid(
          () =>
            createComponent(AgentRunFrame, {
              frame: {
                kind: "agent-run-frame",
                key: "forwarded-frame",
                runId: "forwarded-tools",
                boundaryId: "forwarded-boundary",
                outcome: { kind: "completed", actionOwner: null },
                parts: [group],
              },
              options: runOptions(() => options),
            }),
          { container },
        );
      } else {
        renderTestMessageGroup(group, options);
      }
      await settleToolBridges(container);
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
    const groups = groupMessages([
      narrationEntry(
        "forwarded-tool-narration",
        [
          { type: "text", text: "See `reports/index.html:7`" },
          readCall("read-report", "reports/index.html"),
        ],
        {
          timestamp: 1_000,
          senderSession: { sessionKey },
        },
      ),
      narrationEntry("narrated-file-answer", "Done.", {
        timestamp: 2_000,
        phase: "final_answer",
      }),
    ]).filter((item) => item.kind === "group");
    const frame = coalesceAgentRunFrames(groups).find((item) => item.kind === "agent-run-frame");
    if (!frame) {
      throw new Error("Expected the narrated tool to join its completed run frame");
    }
    mountSolid(
      () =>
        createComponent(AgentRunFrame, {
          frame,
          options: runOptions(() => ({ showReasoning: true })),
        }),
      { container },
    );
    const opened = vi.fn();
    container.addEventListener("click", (event) => opened(markdownFileLinkFromEvent(event)));
    const link = required('a[data-file-path="reports/index.html"]');
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
      renderTestMessageGroup(group);
      if (!forwarded) {
        expect(text(".chat-group.assistant .chat-sender-name")).toBe("Forwarded from main");
        expect(query(".chat-group--forwarded")).toBeNull();
        return;
      }
      const forwardedGroup = query(".chat-group--forwarded");
      expect(forwardedGroup).not.toBeNull();
      expect(forwardedGroup?.classList.contains("chat-group--sender-tint")).toBe(true);
      expect(forwardedGroup?.style.getPropertyValue("--chat-sender-hue")).not.toBe("");
      const attribution = required(
        ".chat-group--forwarded .chat-group-messages > .chat-reply-attribution",
      );
      const link = attribution?.querySelector<HTMLAnchorElement>(
        'a.markdown-session-link[data-session-key="agent:main:main"]',
      );
      expect(attribution?.textContent).toContain("From");
      expect(link).toMatchObject({ textContent: "agent:main:main", tabIndex: 0 });
      const bubble = required(".chat-group--forwarded .chat-bubble");
      expect(attribution.nextElementSibling).toBe(bubble);
      expect(query(".chat-avatar, .chat-avatar-slot")).toBeNull();
      expect(query(".chat-group-footer .chat-sender-name")).toBeNull();
      expect(query(".chat-group-footer .chat-group-timestamp")).not.toBeNull();
      expect(query(".chat-group-footer-actions")).not.toBeNull();

      const { titler } = titlerFor("agent:main:main", "Main session");
      const sourceLink = expectDefined(link, "source session link");
      expect(sourceLink).toBeInstanceOf(HTMLAnchorElement);
      await titler.decorate(sourceLink, true);
      expect(sourceLink.textContent).toBe("Main session");
      renderTestMessageGroup(group);
      const retained = query(".chat-group--forwarded .chat-reply-attribution a");
      expect(retained?.textContent).toBe("Main session");
      expect(retained?.hasAttribute("title")).toBe(false);
    },
  );

  it.each([
    ["research", "blob:research-avatar", "image"],
    ["research", "https://example.test/avatar.png", "face"],
    ["main", "blob:main-avatar", "face"],
    ["removed", "blob:stale-avatar", "empty"],
    [undefined, null, "empty"],
  ] as const)("renders forwarded agent %s with %s as %s", async (agentId, avatar, expected) => {
    const group = createGroup({
      senderSession: { agentId },
    });
    const options = {
      ...agentOptions,
      senderAgentAvatars: new Map(agentId ? [[agentId, avatar]] : []),
    };
    renderTestMessageGroup(group, options);

    const image = query("img.chat-avatar.assistant");
    expect(image !== null).toBe(expected === "image");
    if (expected === "empty") {
      expect(query(".chat-avatar, .chat-avatar-slot")).toBeNull();
    }
    if (expected === "image") {
      expect(image).toMatchObject({ src: avatar, alt: "Research Agent" });
    }
    if (expected === "face") {
      await vi.dynamicImportSettled();
      await vi.waitFor(() => expect(query(".identity-avatar__agent-face")).not.toBeNull());
      expect(query(".chat-avatar--sender-initials")).toBeNull();
    }
  });

  it.each([
    ["agent:main:main", "Named source", undefined, "/chat/main"],
    [
      "agent:main:cron:daily:run:first",
      "Daily report",
      undefined,
      "/automations?job=daily&run=first",
    ],
    [
      "agent:main:cron:daily report:run:first+run",
      undefined,
      "/control",
      "/control/automations?job=daily+report&run=first%2Brun",
    ],
  ] as const)(
    "uses the Gateway label and encoded destination for %s",
    async (key, label, basePath, href) => {
      const chipText = label ?? "Automation";
      const group = createGroup({
        senderSession: { sessionKey: key, agentId: key.split(":")[1], label },
      });
      renderTestMessageGroup(group, {
        ...agentOptions,
        mainKey: "main",
        basePath,
      });

      const chip = expectDefined(
        container.querySelector<HTMLAnchorElement>("a.markdown-session-link"),
        "a.markdown-session-link",
      );
      expect(chip).toBeInstanceOf(HTMLAnchorElement);
      expect(chip.textContent?.trim()).toBe(chipText);
      expect(chip.querySelector(":scope > .session-label")?.textContent).toBe(chipText);
      expect(chip.classList.contains("markdown-session-link--titled")).toBe(true);
      const isCronRun = key.includes(":cron:");
      expect(chip.getAttribute("data-session-key")).toBe(isCronRun ? null : key);
      const attributionText =
        text(".chat-group--forwarded .chat-reply-attribution")?.replace(/\s+/g, " ").trim() ?? "";
      expect(attributionText).not.toContain("—");
      const { titler, request } = titlerFor(key, "Client session title");
      await titler.decorate(chip, true);
      expect(chip.textContent?.trim()).toBe(chipText);
      expect(chip.getAttribute("href")).toBe(href);
      if (isCronRun) {
        expect(request).not.toHaveBeenCalled();
      }
      if (key.includes(":cron:")) {
        expect(chip.querySelector(".session-link-icon svg")?.namespaceURI).toBe(
          "http://www.w3.org/2000/svg",
        );
      }
    },
  );

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
      renderTestMessageGroup(group);

      expect(query(".chat-session-activity")).not.toBeNull();
      const attribution = query(".chat-session-activity .chat-reply-attribution");
      expect(attribution?.textContent?.replace(/\s+/g, " ").trim()).toBe(label);
      expect(attribution?.querySelector("a")).toBeNull();
      expect(attribution?.querySelector("[tabindex]")).toBeNull();
      expect(query(".chat-group-footer .chat-sender-name")).toBeNull();
    },
  );
});

const message = {
  role: "user",
  content: "Please review the release fixes.",
  __openclaw: { id: "original", senderIsOwner: true },
};
const viewers = [
  { userId: "alex", userName: "Alex", userAvatar: "AV" },
  { userId: "maya", userName: "Maya", userAvatar: "MV" },
  { userId: null, userName: null, userAvatar: null },
];

function groupFor(input: unknown) {
  const [group] = groupMessages([{ kind: "message", key: "saved-input", message: input }]);
  if (group?.kind !== "group") {
    throw new Error("Expected a visible input group");
  }
  return group;
}

it.each([
  { name: "owner-only gutter", avatarPlacement: "gutter", sender: undefined },
  { name: "owner-only footer", avatarPlacement: "footer", sender: undefined },
  {
    name: "unqualified sender",
    avatarPlacement: "gutter",
    sender: { senderId: "alex", senderName: "Recorded author" },
  },
  {
    name: "remote sender",
    avatarPlacement: "gutter",
    sender: {
      senderId: "alex",
      senderName: "Recorded author",
      senderIdentity: {
        type: "observation",
        pluginId: "discord",
        accountId: "work",
        senderKind: "human",
        id: "alex",
      },
    },
  },
] as const)("does not borrow the viewer's identity for $name", ({ avatarPlacement, sender }) => {
  const input = sender ? { ...message, __openclaw: sender } : message;
  const original = structuredClone(input);
  for (const viewer of sender ? [viewers[0]] : viewers) {
    view.render(groupFor(input), {
      showReasoning: false,
      showToolCalls: true,
      showOwnSenderName: false,
      avatarPlacement,
      ...viewer,
    });
    expect(text(".chat-sender-name")).toBe(sender ? "Recorded author" : "Message");
    expect(query("a.chat-sender-name, img")).toBeNull();
    if (sender) {
      expect(text(".chat-avatar")?.trim()).toBe("RA");
    } else {
      expect(query(".chat-avatar, .chat-author-avatar, .chat-group--peer")).toBeNull();
      expect(text(".chat-text")).toContain(message.content);
    }
  }
  expect(input).toEqual(original);
});

it.each(["loaded", "fetched"] as const)(
  "labels %s reply previews without borrowing the viewer",
  (location) => {
    const props = { ...viewers[0], assistantName: "OpenClaw" };
    const chain = projectTranscriptChain([groupFor(message)], {
      sessionKey: "agent:main:historical",
      runWorking: false,
      searchActive: false,
    });
    const loaded =
      location === "loaded"
        ? projectTranscriptIndex(chain, new Map(), props).loadedReplySources
        : new Map<string, LoadedReplySource>();
    const resolve = createReplyPreviewResolver(loaded, {
      ...props,
      replyMessageAccess: {
        revision: 0,
        navigationId: null,
        read: () => message,
        open: () => undefined,
      },
    });
    expect(resolve("original")).toMatchObject({ senderLabel: "Message", text: message.content });
  },
);
