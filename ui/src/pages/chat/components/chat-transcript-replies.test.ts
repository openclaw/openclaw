/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import * as chatMessage from "./chat-message-group.ts";
import {
  getTranscriptState,
  renderTranscriptSearch,
  toggleTranscriptSearch,
} from "./chat-thread-interactions.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

function requireElement(container: ParentNode, selector: string): HTMLElement {
  return expectDefined(container.querySelector<HTMLElement>(selector), selector);
}

describe("chat transcript replies", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  function replyMessages(
    client?: readonly [id: string, mode: string, displayName: string] | null,
    namedHuman = false,
  ) {
    const [id, mode, displayName] = client ?? [];
    return [
      {
        role: client ? "user" : "assistant",
        content: "The original answer",
        __openclaw: {
          id: "source-message",
          ...(namedHuman
            ? {
                senderId: "profile-alice",
                senderName: "Alice",
                senderIdentity: { type: "profile", id: "profile-alice" },
              }
            : {}),
          ...(client ? { transport: { clients: [{ id, mode, displayName }] } } : {}),
        },
        timestamp: 1_000,
      },
      {
        role: "user",
        content: "Follow up",
        __openclaw: { id: "reply-message", replyToId: "source-message" },
        timestamp: 2_000,
      },
    ] as const;
  }

  it.each([false, true])(
    "resolves persisted replies and owns their flash lifetime (reduced motion: %s)",
    async (reducedMotion) => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query.includes("prefers-reduced-motion") && reducedMotion,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      const props = threadProps("pane-reply-preview", "agent:main:main", [...replyMessages()]);
      render(renderChatThread(props, transcript), container);
      transcript.hostConnected();
      transcript.hostUpdated();
      await flushDeferredRowPrune();

      const preview = container.querySelector<HTMLButtonElement>(
        ".chat-reply-attribution--inline button",
      );
      expect(preview?.getAttribute("aria-label")).toBe("Replying to Molty");
      expect(preview?.textContent).not.toContain("source-message");

      const sourceBubble = [...container.querySelectorAll<HTMLElement>(".chat-bubble")].find(
        (bubble) => bubble.dataset.entryId === "source-message",
      )!;
      const duration = reducedMotion ? 1_000 : 1_200;
      vi.useFakeTimers();
      try {
        preview?.click();
        await Promise.resolve();
        expect(sourceBubble.classList.contains("chat-bubble--reply-target")).toBe(true);
        sourceBubble.firstElementChild!.dispatchEvent(new Event("animationend", { bubbles: true }));
        expect(sourceBubble.classList.contains("chat-bubble--reply-target")).toBe(true);
        vi.advanceTimersByTime(duration / 2);
        preview?.click();
        await Promise.resolve();
        vi.advanceTimersByTime(duration - 1);
        expect(sourceBubble.classList.contains("chat-bubble--reply-target")).toBe(true);
        vi.advanceTimersByTime(1);
        expect(sourceBubble.classList.contains("chat-bubble--reply-target")).toBe(false);
        preview?.click();
        await Promise.resolve();
        transcript.hostDisconnected();
        expect(sourceBubble.classList.contains("chat-bubble--reply-target")).toBe(false);
      } finally {
        transcript.hostDisconnected();
        vi.useRealTimers();
      }
    },
  );

  it("reveals a loaded original without text instead of paging history", async () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const open = vi.fn();
    const props = threadProps("pane-reply-textless", "agent:main:main", [
      // Rendered for its own reply line, with no text of its own.
      {
        role: "user",
        content: [],
        __openclaw: { id: "textless", replyToId: "elsewhere" },
        timestamp: 1_000,
      },
      {
        role: "user",
        content: "Follow up",
        __openclaw: { id: "reply-message", replyToId: "textless" },
        timestamp: 2_000,
      },
    ]);
    props.replyMessageAccess = {
      revision: 0,
      navigationId: null,
      read: () => undefined,
      request: vi.fn(),
      open,
    };
    try {
      render(renderChatThread(props, transcript), container);
      transcript.hostConnected();
      transcript.hostUpdated();
      await flushDeferredRowPrune();
      requireElement(container, ".chat-reply-attribution--inline button").click();
      await Promise.resolve();
      expect(open).not.toHaveBeenCalled();
      expect(
        requireElement(container, "[data-entry-id='textless']").classList.contains(
          "chat-bubble--reply-target",
        ),
      ).toBe(true);
    } finally {
      transcript.hostDisconnected();
    }
  });

  it.each([
    ["assistant", null, false, "Molty"],
    ["CLI", ["cli", "cli", "Release helper"], false, "via CLI (Release helper)"],
    ["RPC", ["gateway-client", "backend", "Build helper"], false, "via RPC (Build helper)"],
    ["named human via CLI", ["cli", "cli", "Release helper"], true, "Alice"],
  ] as const)(
    "hydrates an unloaded %s reply preview without inserting its source row",
    async (_source, client, namedHuman, senderLabel) => {
      const [sourceMessage, followUp] = replyMessages(client, namedHuman);
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      let resolvedMessage: unknown = undefined;
      const request = vi.fn();
      const open = vi.fn();
      const props = {
        ...threadProps("pane-reply-hydration", "agent:main:main", [followUp]),
        userId: "profile-viewer",
        userName: "Unrelated Viewer",
        replyMessageAccess: {
          revision: 0,
          navigationId: null,
          read: () => resolvedMessage,
          request,
          open,
        },
      };
      const rerender = () => {
        render(renderChatThread(props, transcript), container);
        transcript.hostUpdated();
      };
      try {
        rerender();
        transcript.hostConnected();
        await flushDeferredRowPrune();

        expect(request).toHaveBeenCalledWith("source-message");
        expect(container.querySelector("[data-entry-id='source-message']")).toBeNull();

        resolvedMessage = { ...sourceMessage, content: "The original message" };
        props.replyMessageAccess.revision += 1;
        rerender();

        const preview = container.querySelector<HTMLButtonElement>(
          ".chat-reply-attribution--inline button",
        );
        expect(preview?.querySelector(".chat-reply-attribution__name")?.textContent?.trim()).toBe(
          senderLabel,
        );
        expect(container.querySelector("[data-entry-id='source-message']")).toBeNull();
        preview?.click();
        expect(open).toHaveBeenCalledWith("source-message");
      } finally {
        transcript.hostDisconnected();
      }
    },
  );

  it.each([false, true])(
    "opens folded work when a reply navigation loads its source (run frame: %s)",
    async (framed) => {
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      const [sourceMessage, followUp] = replyMessages();
      const props = threadProps("pane-folded-history-reply", "agent:main:dashboard:reply", [
        followUp,
      ]);
      const open = vi.fn();
      props.replyMessageAccess = {
        revision: 0,
        navigationId: null,
        read: () => sourceMessage,
        request: vi.fn(),
        open,
      };
      const rerender = () => {
        render(renderChatThread(props, transcript), container);
        transcript.hostUpdated();
      };
      try {
        rerender();
        transcript.hostConnected();
        await flushDeferredRowPrune();
        requireElement(container, ".chat-reply-attribution--inline button").click();
        expect(open).toHaveBeenCalledWith("source-message");
        props.replyMessageAccess.navigationId = "source-message";
        props.messages = [
          {
            role: "user",
            content: "Prepare an answer",
            timestamp: 0,
            ...(framed ? { __openclaw: { idempotencyKey: "source-run:user" } } : {}),
          },
          { ...sourceMessage, ...(framed ? { runId: "source-run" } : {}) },
          {
            role: "assistant",
            phase: "final_answer",
            content: "Final answer",
            timestamp: 1_500,
            ...(framed ? { runId: "source-run" } : {}),
          },
          followUp,
        ];
        rerender();
        await flushDeferredRowPrune();
        expect(
          requireElement(container, ".chat-work-group button").getAttribute("aria-expanded"),
        ).toBe("true");
        expect(requireElement(container, "[data-entry-id='source-message']").textContent).toContain(
          "The original answer",
        );
      } finally {
        transcript.hostDisconnected();
      }
    },
  );

  const alice = {
    senderId: "alice",
    senderName: "Alice",
    senderIdentity: { type: "profile", id: "alice" },
  };
  const bob = {
    senderId: "bob",
    senderName: "Bob",
    senderIdentity: { type: "profile", id: "bob" },
  };
  const turn = (id: string, role: string, content: string, openclaw: object = {}) => ({
    role,
    content,
    timestamp: Number(id.replace(/\D/g, "")),
    __openclaw: { id, ...openclaw },
  });
  async function renderedStrips(props: ReturnType<typeof threadProps>, searchQuery?: string) {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    if (searchQuery) {
      Object.assign(getTranscriptState(props.paneId), { searchOpen: true, searchQuery });
    }
    render(renderChatThread(props, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();
    transcript.hostDisconnected();
    const strips = [...container.querySelectorAll(".chat-reply-attribution--reply")].map((strip) =>
      strip.querySelector(".chat-reply-attribution__name")?.textContent?.trim(),
    );
    // No reply cue renders beyond the named strips.
    expect(container.textContent?.split("Replying to").length).toBe(strips.length + 1);
    return strips;
  }

  it.each([
    {
      case: "search hides the other speaker",
      messages: [
        turn("p1", "user", "Deploy?", alice),
        turn("a2", "assistant", "Deploying"),
        turn("p3", "user", "Status?", bob),
        turn("a4", "assistant", "Rollout done"),
      ],
      query: "Rollout",
      strips: ["Bob"],
    },
    {
      case: "search hides the prompt this turn answers",
      messages: [
        turn("p1", "user", "Rollout plan?", alice),
        turn("a2", "assistant", "Drafted"),
        turn("p3", "user", "Anything else?", alice),
        turn("a4", "assistant", "Rollout finished", {
          replyToId: "p3",
          replyToPreview: { text: "Anything else?", senderLabel: "Alice" },
        }),
      ],
      query: "Rollout",
      strips: [],
    },
    {
      case: "a system turn replies explicitly to an older human prompt",
      messages: [
        turn("p1", "user", "Please check this report", {
          ...alice,
          idempotencyKey: "run-a:user",
        }),
        {
          ...turn("p2", "user", "[System] Scheduled report", { idempotencyKey: "run-b:user" }),
          provenance: { kind: "internal_system", sourceTool: "cron" },
        },
        {
          ...turn("a3", "assistant", "Answer to the older prompt", { replyToId: "p1" }),
          runId: "run-b",
        },
      ],
      strips: ["Alice"],
    },
    {
      // An explicit reply to its own prompt stays visible once the thread is shared.
      case: "the session has a participant outside the loaded page",
      messages: [
        turn("p1", "user", "Deploy?", alice),
        turn("a2", "assistant", "Deploying", { replyToId: "p1" }),
      ],
      session: {
        owner: {
          actor: { type: "human", id: "alice", identity: { type: "profile", id: "alice" } },
        },
        participants: [{ identity: { type: "profile", id: "bob" }, label: "Bob" }],
      },
      strips: ["Alice"],
    },
    {
      // The owner listed again as a participant, keys reordered, is still one person.
      case: "the owner reappears as a participant with reordered identity keys",
      messages: [
        turn("p1", "user", "Deploy?", alice),
        turn("a2", "assistant", "Deploying", { replyToId: "p1" }),
      ],
      session: {
        owner: {
          actor: { type: "human", id: "alice", identity: { type: "profile", id: "alice" } },
        },
        participants: [{ identity: { id: "alice", type: "profile" }, label: "Alice" }],
      },
      strips: [],
    },
  ])(
    "keeps reply attribution from the full conversation when $case",
    async ({ messages, query, session, strips }) => {
      const props = threadProps("pane-reply-context", "agent:main:main", [...messages]);
      if (session) {
        props.selectedSession = {
          key: props.sessionKey,
          kind: "direct",
          updatedAt: 1,
          ...session,
        } as GatewaySessionRow;
      }
      expect(await renderedStrips(props, query)).toEqual(strips);
    },
  );

  it.each([
    { linkage: "the prompt that owns its run", strips: ["Alice"] },
    { linkage: "its own prompt in a 1:1 thread", latest: null, strips: [] },
    { linkage: "an older prompt in a 1:1 thread", latest: alice, strips: ["Alice"] },
    { linkage: "a legacy reply without a run", replyRun: null, strips: [] },
    { linkage: "a prompt without a run key", promptRun: null, strips: [] },
    { linkage: "another run's prompt", promptRun: "run-b", strips: [] },
    { linkage: "duplicate run owners", duplicate: true, strips: [] },
    {
      linkage: "a channel-mirrored reply keyed only by its send",
      reply: { mirrorOrigin: "discord", idempotencyKey: "run-a" },
      strips: [],
    },
  ])(
    "attributes reply_to_current only through $linkage",
    async ({ promptRun = "run-a", replyRun = "run-a", latest = bob, duplicate, reply, strips }) => {
      const props = threadProps("pane-reply-current", "agent:main:main", [
        ...(duplicate
          ? [turn("p1", "user", "Earlier", { ...alice, idempotencyKey: "run-a:user" })]
          : []),
        turn("p2", "user", "hey hey", {
          ...alice,
          ...(promptRun ? { idempotencyKey: `${promptRun}:user` } : {}),
        }),
        // The latest prompt never stands in for an unresolved origin.
        ...(latest ? [turn("p3", "user", "Unrelated", latest)] : []),
        {
          ...turn("a4", "assistant", "Tô aqui", reply ?? (replyRun ? { runId: replyRun } : {})),
          openclawDelivery: { replyToCurrent: true },
        },
      ]);
      expect(await renderedStrips(props)).toEqual(strips);
    },
  );

  it.each([
    { target: "loaded explicit", loaded: true, readOnly: false },
    { target: "unloaded explicit", loaded: false, readOnly: false },
    { target: "loaded automatic in a read-only archive", loaded: true, readOnly: true },
  ])("clears search and navigates to a $target reply target", async ({ loaded, readOnly }) => {
    vi.useFakeTimers();
    const transcript = createTestTranscript();
    const searchContainer = document.body.appendChild(document.createElement("div"));
    const threadContainer = document.body.appendChild(document.createElement("div"));
    const open = vi.fn();
    const paneId = "pane-filtered-reply-navigation";
    const [sourceMessage, followUp] = replyMessages();
    const sourceId = readOnly ? "p2" : "source-message";
    const sourceSelector = `[data-entry-id='${sourceId}']`;
    const props = threadProps(
      paneId,
      "agent:main:main",
      readOnly
        ? [
            turn("p1", "user", "Original for Alice", alice),
            turn("p2", "user", "Original for Bob", bob),
            turn("a3", "assistant", "Follow up for Bob"),
          ]
        : [
            ...(loaded ? [sourceMessage] : []),
            {
              ...followUp,
              __openclaw: {
                ...followUp["__openclaw"],
                replyToPreview: { text: "The original answer", senderLabel: "Molty" },
              },
            },
          ],
    );
    if (readOnly) {
      props.selectedSession = {
        key: props.sessionKey,
        kind: "direct",
        updatedAt: 1,
        archived: true,
      };
    } else {
      props.replyMessageAccess = {
        revision: 0,
        navigationId: null,
        read: () => undefined,
        request: vi.fn(),
        open,
      };
    }
    const requestUpdate = () => queueMicrotask(rerender);
    const rerender = () => {
      render(renderTranscriptSearch(paneId, requestUpdate), searchContainer);
      render(
        renderChatThread({ ...props, onRequestUpdate: requestUpdate }, transcript),
        threadContainer,
      );
      transcript.hostUpdated();
    };
    try {
      toggleTranscriptSearch(paneId, requestUpdate);
      rerender();
      transcript.hostConnected();
      const input = requireElement(searchContainer, "input") as HTMLInputElement;
      input.value = "Follow up";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);

      expect(threadContainer.querySelector(sourceSelector)).toBeNull();
      requireElement(threadContainer, ".chat-reply-attribution button").click();
      await vi.advanceTimersByTimeAsync(0);

      expect(searchContainer.querySelector("input")).toBeNull();
      if (loaded) {
        expect(open).not.toHaveBeenCalled();
        expect(
          requireElement(threadContainer, sourceSelector).classList.contains(
            "chat-bubble--reply-target",
          ),
        ).toBe(true);
      } else {
        expect(open).toHaveBeenCalledWith(sourceId);
      }
    } finally {
      transcript.hostDisconnected();
      vi.useRealTimers();
    }
  });

  it.each(["group", "frame"] as const)(
    "refreshes an unchanged reply %s when its older original loads or changes",
    async (presentation) => {
      vi.spyOn(Date, "now").mockReturnValue(60_000);
      const history = [
        {
          role: "user",
          content: "Alice's recent prompt",
          timestamp: 1_000,
          __openclaw: { id: "alice-prompt", senderId: "alice", senderName: "Alice" },
        },
        {
          role: "assistant",
          content: "Unrelated answer",
          timestamp: 2_000,
          __openclaw: { id: "unrelated-answer" },
        },
        {
          role: "user",
          content: "Bob's current prompt",
          timestamp: 3_000,
          __openclaw: {
            id: "bob-prompt",
            senderId: "bob",
            senderName: "Bob",
            idempotencyKey: "reply-run:user",
          },
        },
        {
          role: "assistant",
          content: "Answer to the earlier question",
          timestamp: 4_000,
          phase: "final_answer",
          stopReason: "stop",
          ...(presentation === "frame" ? { runId: "reply-run" } : {}),
          __openclaw: {
            id: "reply-answer",
            replyToId: "older-prompt",
            replyToPreview: { senderLabel: "Old label", text: "Old snapshot" },
          },
        },
      ];
      const props = threadProps(
        `pane-reply-source-${presentation}`,
        "agent:main:dashboard:reply-source",
        history,
      );
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      const rerender = () => {
        render(renderChatThread(props, transcript), container);
        transcript.hostUpdated();
      };
      const attribution = () =>
        expectDefined(
          container
            .querySelector('[data-entry-id="reply-answer"]')
            ?.closest(".chat-group")
            ?.querySelector(".chat-reply-attribution--reply"),
          "reply attribution",
        );
      try {
        rerender();
        transcript.hostConnected();
        await flushDeferredRowPrune();
        // The snapshot names an original outside the loaded history; it still navigates.
        expect(
          attribution().querySelector("button .chat-reply-attribution__name")?.textContent,
        ).toBe("Old label");
        const unrelatedKey = expectDefined(
          container
            .querySelector('[data-entry-id="unrelated-answer"]')
            ?.closest(".chat-group")
            ?.getAttribute("data-chat-row-key"),
          "unrelated group key",
        );
        const renderGroup = vi.spyOn(chatMessage, "renderMessageGroup");

        for (const [name, text] of [
          ["Carol", "Original question loaded"],
          ["Caroline", "Original question corrected"],
        ]) {
          props.messages = [
            {
              role: "user",
              content: text,
              timestamp: 500,
              __openclaw: { id: "older-prompt", senderId: "carol", senderName: name },
            },
            ...history,
          ];
          rerender();
          await flushDeferredRowPrune();
          expect(
            attribution().querySelector("button .chat-reply-attribution__name")?.textContent,
          ).toBe(name);
          expect(renderGroup.mock.calls.filter(([group]) => group.key === unrelatedKey)).toEqual(
            [],
          );
        }
      } finally {
        transcript.hostDisconnected();
      }
    },
  );
});
