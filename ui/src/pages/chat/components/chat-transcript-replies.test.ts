import { expectDefined } from "@openclaw/normalization-core";
/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  createTestTranscript as createTranscript,
  stubAnimationFrames,
} from "../chat-view.test-helpers.ts";
import { projectChatTranscriptMetadata } from "../session-message-cache.ts";
import {
  render,
  renderChatThread,
  renderTranscriptSearch,
} from "../test-helpers/chat-transcript-native.tsx";
import { toggleTranscriptSearch, type ChatThreadProps } from "./chat-thread-interactions.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  requireElement,
  threadProps,
} from "./chat-transcript.test-support.ts";

const transcripts: ReturnType<typeof createTranscript>[] = [];
function createTestTranscript(...args: Parameters<typeof createTranscript>) {
  const transcript = createTranscript(...args);
  transcripts.push(transcript);
  return transcript;
}
function threadView(props: ChatThreadProps, transcript = createTestTranscript()) {
  const container = document.body.appendChild(document.createElement("div"));
  const rerender = (start = false) => {
    render(renderChatThread(props, transcript), container);
    if (start) {
      transcript.start();
    }
    transcript.update();
  };
  const start = async () => {
    rerender();
    transcript.start();
    await flushDeferredRowPrune();
  };
  return { transcript, container, rerender, start };
}
const inlineReply = ".chat-reply-attribution--inline button";
const replyName = ".chat-reply-attribution__name";
const replyTarget = "chat-bubble--reply-target";
function expectEntryText(container: HTMLElement, id: string, text: string) {
  expect(requireElement(container, `[data-entry-id="${id}"]`).textContent).toContain(text);
}
function replyAccess(
  read: () => unknown = () => undefined,
): NonNullable<ChatThreadProps["replyMessageAccess"]> {
  return { revision: 0, navigationId: null, read, open: vi.fn() };
}
function replyProps(messages: ChatThreadProps["messages"], changes: Partial<ChatThreadProps> = {}) {
  return threadProps("replies", "agent:main:main", messages, changes);
}

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  for (const transcript of transcripts.splice(0)) {
    transcript.dispose();
  }
  vi.useRealTimers();
  resetTranscriptTestDom();
});

function replyMessages() {
  return [
    turn("source", "assistant", "The original answer", {}, 1_000),
    turn("followup", "user", "Follow up", { replyToId: "source" }, 2_000),
  ] as const;
}

it.each([
  { name: "ordinary motion", reducedMotion: false, textless: false },
  { name: "reduced motion", reducedMotion: true, textless: false },
  { name: "textless original", reducedMotion: false, textless: true },
])(
  "reveals loaded replies and owns their flash lifetime: $name",
  async ({ reducedMotion, textless }) => {
    const flushFrames = stubAnimationFrames();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion") && reducedMotion,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const [source, reply] = replyMessages();
    const access = replyAccess();
    const props = replyProps([
      textless
        ? {
            ...source,
            role: "user",
            content: [],
            __openclaw: { ...source["__openclaw"], replyToId: "elsewhere" },
          }
        : source,
      reply,
    ]);
    props.replyMessageAccess = access;
    const { transcript, container, rerender } = threadView(props);
    rerender(true);
    await flushDeferredRowPrune();

    const preview = container.querySelector<HTMLButtonElement>(inlineReply);
    if (!textless) {
      expect(preview?.getAttribute("aria-label")).toBe("Replying to Molty");
    }
    expect(preview?.textContent).not.toContain("source");

    const sourceBubble = requireElement(container, ".chat-bubble[data-entry-id='source']");
    const clickReply = async () => {
      preview?.click();
      await Promise.resolve();
      flush();
      await Promise.resolve();
      flushFrames();
      flush();
      await Promise.resolve();
    };
    const duration = reducedMotion ? 1_000 : 1_200;
    vi.useFakeTimers({ toNotFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    await clickReply();
    expect(access.open).not.toHaveBeenCalled();
    expect(sourceBubble.classList.contains(replyTarget)).toBe(true);
    if (!textless) {
      sourceBubble.firstElementChild!.dispatchEvent(new Event("animationend", { bubbles: true }));
    }
    expect(sourceBubble.classList.contains(replyTarget)).toBe(true);
    vi.advanceTimersByTime(duration / 2);
    await clickReply();
    vi.advanceTimersByTime(duration - 1);
    expect(sourceBubble.classList.contains(replyTarget)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(sourceBubble.classList.contains(replyTarget)).toBe(false);
    await clickReply();
    transcript.dispose();
    expect(sourceBubble.classList.contains(replyTarget)).toBe(false);
  },
);

it("hydrates an unloaded reply preview without inserting its source row", async () => {
  const [sourceMessage, followUp] = replyMessages();
  let resolvedMessage: unknown = undefined;
  const access = replyAccess(() => resolvedMessage);
  const props = replyProps([followUp], {
    userId: "profile-viewer",
    userName: "Unrelated Viewer",
    replyMessageAccess: access,
  });
  const { container, rerender, start } = threadView(props);
  await start();

  expect(container.querySelector("[data-entry-id='source']")).toBeNull();

  resolvedMessage = { ...sourceMessage, content: "The original message" };
  access.revision += 1;
  rerender();

  const preview = container.querySelector<HTMLButtonElement>(inlineReply);
  expect(preview?.querySelector(replyName)?.textContent?.trim()).toBe("Molty");
  expect(container.querySelector("[data-entry-id='source']")).toBeNull();
  preview?.click();
  expect(access.open).toHaveBeenCalledWith("source");
});

it.each([false, true])(
  "reveals visible assistant text when reply navigation loads its source (run frame: %s)",
  async (framed) => {
    const [sourceMessage, followUp] = replyMessages();
    const props = replyProps([followUp], { sessionKey: "agent:main:dashboard:reply" });
    const access = replyAccess(() => sourceMessage);
    props.replyMessageAccess = access;
    const { transcript, container, rerender, start } = threadView(
      props,
      createTestTranscript(props.paneId),
    );
    await start();
    const viewport = requireElement(container, ".chat-thread");
    viewport.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
      viewport.scrollTop = typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
      viewport.dispatchEvent(new Event("scroll"));
    };
    requireElement(container, inlineReply).click();
    expect(access.open).toHaveBeenCalledWith("source");
    props.replyMessageAccess.navigationId = "source";
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
    expect(transcript.revealMessage("source")).toBe(true);
    rerender();
    await flushDeferredRowPrune();
    expect(container.querySelector(".chat-work-group")).toBeNull();
    expect(requireElement(container, "[data-entry-id='source']").textContent).toContain(
      "The original answer",
    );
  },
);

it.each([true, false])(
  "keeps answers and independent automation deliveries visible (foreground run identity: %s)",
  async (keyed) => {
    const runId = "approval-question-run";
    const run = keyed ? { runId } : {};
    const prompt = keyed ? { idempotencyKey: `${runId}:user` } : {};
    const props = threadProps("pane-automation-replies", "agent:main:dashboard:approval", [
      turn("question", "user", "How was that approved?", prompt, 1_000),
      {
        ...turn("commentary", "assistant", "Checking the saved approval.", run, 2_000),
        phase: "commentary",
      },
      {
        ...turn("answer", "assistant", "An operator approved it.", run, 3_000),
        stopReason: "stop",
      },
    ]);
    const { container, rerender, start } = threadView(props);
    await start();
    expectEntryText(container, "answer", "An operator approved it.");
    expectEntryText(container, "commentary", "Checking the saved approval.");
    for (const index of [1, 2]) {
      props.messages = [
        ...props.messages,
        {
          role: "assistant",
          api: "openclaw-transcript",
          provider: "openclaw",
          model: "automation-result",
          stopReason: "stop",
          content: `New application error ${index}.`,
          timestamp: (3 + index) * 1_000,
          openclawAutomation: { kind: "cron", jobId: "saved-watcher", runId: `cron-${index}` },
          __openclaw: { id: `alert-${index}` },
        },
      ];
      rerender();
      await flushDeferredRowPrune();
      expectEntryText(container, "answer", "An operator approved it.");
      for (let alert = 1; alert <= index; alert++) {
        expectEntryText(container, `alert-${alert}`, `New application error ${alert}.`);
      }
      expectEntryText(container, "commentary", "Checking the saved approval.");
    }
    props.messages = structuredClone(props.messages);
    rerender();
    await flushDeferredRowPrune();
    expectEntryText(container, "answer", "An operator approved it.");
    expectEntryText(container, "alert-2", "New application error 2.");
    expectEntryText(container, "commentary", "Checking the saved approval.");
    props.runId = "next-foreground-run";
    props.runActive = true;
    props.runWorking = true;
    props.streamStartedAt = 6_000;
    rerender();
    await flushDeferredRowPrune();
    const alert = requireElement(container, '[data-entry-id="alert-2"]');
    const progress = requireElement(container, ".chat-working-indicator");
    expect(alert.closest(".chat-group")?.contains(progress)).toBe(false);
    expect(alert.closest(".chat-agent-run-frame")?.contains(progress) ?? false).toBe(false);
  },
);

const person = (id: string, name: string) => ({
  senderId: id,
  senderName: name,
  senderIdentity: { type: "profile", id },
});
const alice = person("alice", "Alice");
const bob = person("bob", "Bob");
const owner: NonNullable<GatewaySessionRow["owner"]> = {
  actor: { type: "human", id: "alice", identity: { type: "profile", id: "alice" } },
};
const turn = (
  id: string,
  role: string,
  content: string,
  openclaw: object = {},
  timestamp = Number(id.replace(/\D/g, "")),
) => ({
  role,
  content,
  timestamp,
  __openclaw: { id, ...openclaw },
});
const ownPromptReply = [
  turn("p1", "user", "Deploy?", alice),
  turn("a2", "assistant", "Deploying", { replyToId: "p1" }),
];
const keyedPrompt = (run = "run-a") =>
  turn("p2", "user", "hey hey", { ...alice, idempotencyKey: run + ":user" });
const prompt = keyedPrompt();
const unrelated = turn("p3", "user", "Unrelated", bob);
const answer = (metadata: object = {}) => ({
  ...turn("a4", "assistant", "Tô aqui", metadata),
  openclawDelivery: { replyToCurrent: true },
});
const linkedAnswer = answer({ runId: "run-a" });
const olderPrompt = turn("p3", "user", "Unrelated", alice);
const duplicatePrompt = turn("p1", "user", "Earlier", { ...alice, idempotencyKey: "run-a:user" });
const mirroredAnswer = answer({ mirrorOrigin: "discord", idempotencyKey: "run-a" });
const systemReply = [
  turn("p1", "user", "Report?", { ...alice, idempotencyKey: "run-a:user" }),
  {
    ...turn("p2", "user", "[System] Scheduled report", { idempotencyKey: "run-b:user" }),
    provenance: { kind: "internal_system", sourceTool: "cron" },
  },
  { ...turn("a3", "assistant", "Report", { replyToId: "p1" }), runId: "run-b" },
];
type ContextSession = Pick<GatewaySessionRow, "owner" | "participants">;
type ReplyContext = [string, ChatThreadProps["messages"], string[], ContextSession?];
const outsideParticipant: ContextSession = {
  owner,
  participants: [{ identity: { type: "profile", id: "bob" }, label: "Bob" }],
};
const ownerParticipant: ContextSession = {
  owner,
  participants: [{ identity: { id: "alice", type: "profile" }, label: "Alice" }],
};
it.each<ReplyContext>([
  ["owned run", [prompt, unrelated, linkedAnswer], ["Alice"]],
  ["1:1 current prompt", [prompt, linkedAnswer], []],
  ["1:1 older prompt", [prompt, olderPrompt, linkedAnswer], ["Alice"]],
  ["legacy reply", [prompt, unrelated, answer()], []],
  ["unkeyed prompt", [turn("p2", "user", "hey hey", alice), unrelated, linkedAnswer], []],
  ["another run", [keyedPrompt("run-b"), unrelated, linkedAnswer], []],
  ["ambiguous owners", [duplicatePrompt, prompt, unrelated, linkedAnswer], []],
  ["channel mirror", [prompt, unrelated, mirroredAnswer], []],
  ["system turn answers older human", systemReply, ["Alice"]],
  ["off-page participant", ownPromptReply, ["Alice"], outsideParticipant],
  ["reordered owner identity", ownPromptReply, [], ownerParticipant],
])(
  "keeps cached reply attribution from the full conversation when %s",
  async (_name, messages, strips, session) => {
    const props = replyProps([...messages]);
    if (session) {
      props.transcriptMetadata = projectChatTranscriptMetadata({
        key: props.sessionKey,
        kind: "direct",
        updatedAt: 1,
        ...session,
      } as GatewaySessionRow);
    }
    const { container, rerender } = threadView(props);
    rerender(true);
    await flushDeferredRowPrune();
    const names = [...container.querySelectorAll(".chat-reply-attribution--reply")].map((strip) =>
      strip.querySelector(replyName)?.textContent?.trim(),
    );
    expect(container.textContent?.split("Replying to").length).toBe(names.length + 1);
    expect(names).toEqual(strips);
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
  const access = replyAccess();
  const [sourceMessage, followUp] = replyMessages();
  const sourceId = readOnly ? "p2" : "source";
  const sourceSelector = `[data-entry-id='${sourceId}']`;
  const props = replyProps(
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
    props.replyMessageAccess = access;
  }
  const rerender = () => {
    render(renderTranscriptSearch(props.paneId), searchContainer);
    render(renderChatThread(props, transcript), threadContainer);
    transcript.update();
  };
  toggleTranscriptSearch(props.paneId);
  rerender();
  transcript.start();
  const input = await waitForSolid(
    () => requireElement(searchContainer, "input") as HTMLInputElement,
  );
  input.value = "Follow up";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(0);

  expect(threadContainer.querySelector(sourceSelector)).toBeNull();
  requireElement(threadContainer, ".chat-reply-attribution button").click();
  await vi.advanceTimersByTimeAsync(0);
  flush();
  await Promise.resolve();
  vi.advanceTimersToNextFrame();
  flush();
  await Promise.resolve();

  expect(searchContainer.querySelector("input")).toBeNull();
  if (loaded) {
    expect(access.open).not.toHaveBeenCalled();
    expect(requireElement(threadContainer, sourceSelector).classList.contains(replyTarget)).toBe(
      true,
    );
  } else {
    expect(access.open).toHaveBeenCalledWith(sourceId);
  }
});

it.each(["group", "frame"] as const)(
  "refreshes an unchanged reply %s when its older original loads or changes",
  async (presentation) => {
    vi.spyOn(Date, "now").mockReturnValue(60_000);
    const history = [
      turn("p1000", "user", "Alice", { senderId: "alice", senderName: "Alice" }),
      turn("p3000", "user", "Bob", {
        senderId: "bob",
        senderName: "Bob",
        idempotencyKey: "reply-run:user",
      }),
      {
        ...turn("a4000", "assistant", "Answer", {
          replyToId: "p500",
          replyToPreview: { senderLabel: "Old label", text: "Old snapshot" },
        }),
        phase: "final_answer",
        stopReason: "stop",
        ...(presentation === "frame" ? { runId: "reply-run" } : {}),
      },
    ];
    const props = replyProps(history, { sessionKey: "agent:main:dashboard:reply-source" });
    const { container, rerender, start } = threadView(props);
    const attribution = () =>
      expectDefined(
        container
          .querySelector('[data-entry-id="a4000"]')
          ?.closest(".chat-group")
          ?.querySelector(".chat-reply-attribution--reply"),
        "reply attribution",
      );
    await start();
    expect(attribution().querySelector(`button ${replyName}`)?.textContent).toBe("Old label");

    for (const [name, text] of [
      ["Carol", "Original question loaded"],
      ["Caroline", "Original question corrected"],
    ] as const) {
      props.messages = [
        turn("p500", "user", text, { senderId: "carol", senderName: name }),
        ...history,
      ];
      rerender();
      await flushDeferredRowPrune();
      expect(attribution().querySelector(`button ${replyName}`)?.textContent).toBe(name);
    }
  },
);
