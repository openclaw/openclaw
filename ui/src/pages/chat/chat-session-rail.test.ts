/* @vitest-environment jsdom */

import { createMemo, createRoot, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { currentThemeBranding, setCurrentThemeBranding } from "../../app/theme-branding.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import {
  ChatSessionCompanionThreads,
  requestSessionCompanionAnswer,
} from "./chat-session-companion.ts";
import type { ChatSessionRailElement } from "./components/chat-session-rail.tsx";
import "./components/chat-session-rail.tsx";

function digest(health: SessionObserverDigest["health"] = "on-track"): SessionObserverDigest {
  return {
    sessionKey: "agent:main:run",
    runId: "run-1",
    revision: 1,
    updatedAt: 300_000,
    headline: "Reviewing the implementation",
    health,
  };
}

describe("ChatSessionCompanionThreads", () => {
  it("publishes in-place answer settlement through its owner projection", async () => {
    const threads = new ChatSessionCompanionThreads();
    let readStatuses!: () => string[];
    const dispose = createRoot((disposeRoot) => {
      const projected = projectOwner(threads, (owner) => owner);
      readStatuses = createMemo(() =>
        projected
          .read()
          .view("one")
          .turns.map((turn) => turn.status),
      );
      return disposeRoot;
    });
    let answer!: (value: { answer: string; ts: number }) => void;
    try {
      expect(readStatuses()).toEqual([]);
      const pending = threads.submit(
        "one",
        "Question",
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
      const turn = threads.view("one").turns[0];
      expect(turn?.status).toBe("pending");
      flush();
      expect(readStatuses()).toEqual(["pending"]);
      answer({ answer: "Answer", ts: 1 });
      await pending;
      flush();
      expect(readStatuses()).toEqual(["answered"]);
      expect(threads.view("one").turns[0]).toBe(turn);
    } finally {
      dispose();
      threads.retire();
    }
  });

  it("sends companion questions with the bounded RPC timeout", async () => {
    const request = vi.fn(async () => ({ answer: "Answer", ts: 1 }));
    const client = { request: request as GatewayBrowserClient["request"] };

    await requestSessionCompanionAnswer(client, "one", "Question", "work");

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "sessions.companion.ask",
      { sessionKey: "one", agentId: "work", question: "Question" },
      { timeoutMs: 70_000 },
    );
  });

  it("sends a full selected passage as context, not an unsupported file", async () => {
    const selectedText = "Full selected passage " + "x".repeat(2_000);
    const request = vi.fn(async (_method: string, _params: unknown) => ({
      answer: "Answer",
      ts: 1,
    }));
    const client = { request: request as GatewayBrowserClient["request"] };
    await requestSessionCompanionAnswer(client, "one", "Regarding the selection", "work", [
      {
        id: "comment",
        mimeType: "text/plain",
        selectionAnnotation: {
          text: selectedText,
          comment: "Why does this matter?",
          sessionKey: "one",
          start: 2,
          end: selectedText.length + 2,
        },
      },
    ]);
    expect(request).toHaveBeenCalledWith(
      "sessions.companion.ask",
      {
        sessionKey: "one",
        agentId: "work",
        question: "Regarding the selection",
        selectionContext: expect.stringContaining("User comment:\nWhy does this matter?"),
      },
      { timeoutMs: 70_000 },
    );
    expect(request.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        selectionContext: expect.stringContaining(`Selected text:\n${selectedText}`),
      }),
    );
  });

  it("keeps matching bare session keys isolated by agent", () => {
    const threads = new ChatSessionCompanionThreads();
    threads.setDraft("global", "main draft", "main");
    threads.setDraft("global", "work draft", "work");

    expect(threads.view("global", "main").draft).toBe("main draft");
    expect(threads.view("global", "work").draft).toBe("work draft");
  });

  it("maps the typed busy error to the rail hint", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "Is it stuck?", async () => {
      throw Object.assign(new Error("busy"), {
        details: { code: "SESSION_COMPANION_BUSY" },
        retryable: true,
      });
    });

    expect(threads.view("one").turns).toMatchObject([
      { question: "Is it stuck?", status: "failed", hint: "busy", retryable: true },
    ]);
  });

  it("hydrates only a newly committed repeated question after a lost response", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.hydrate("one", async () => ({
      exchanges: [{ question: "What changed?", answer: "Earlier answer.", ts: 1 }],
    }));
    await threads.submit("one", "What changed?", async () => {
      throw new Error("socket closed");
    });
    expect(threads.view("one").turns).toMatchObject([
      { question: "What changed?", status: "answered", answer: "Earlier answer.", ts: 1 },
      { question: "What changed?", status: "failed", hint: "unavailable", retryable: true },
    ]);

    await threads.hydrate("one", async () => ({
      exchanges: [{ question: "What changed?", answer: "Earlier answer.", ts: 1 }],
    }));
    expect(threads.view("one").turns).toMatchObject([
      { question: "What changed?", status: "answered", answer: "Earlier answer.", ts: 1 },
      { question: "What changed?", status: "failed", hint: "unavailable", retryable: true },
    ]);

    await threads.hydrate("one", async () => ({
      exchanges: [
        { question: "What changed?", answer: "Earlier answer.", ts: 1 },
        { question: "What changed?", answer: "The fix committed.", ts: 4 },
      ],
    }));

    expect(threads.view("one").turns).toMatchObject([
      { question: "What changed?", status: "answered", answer: "Earlier answer.", ts: 1 },
      { question: "What changed?", status: "answered", answer: "The fix committed.", ts: 4 },
    ]);
  });

  it("clears local state only after the reset RPC succeeds", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.hydrate("one", async () => ({
      exchanges: [{ question: "Q", answer: "A", ts: 1 }],
    }));
    await expect(
      threads.reset("one", async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(threads.view("one").turns).toHaveLength(1);

    await threads.reset("one", async () => ({ ok: true as const }));
    expect(threads.view("one").turns).toMatchObject([]);
  });

  it("retires one session without clearing unrelated companion state", () => {
    const threads = new ChatSessionCompanionThreads();
    threads.setDraft("one", "retire me", "main");
    threads.setDraft("two", "keep me", "main");

    threads.retire("one", "main");

    expect(threads.view("one", "main").draft).toBe("");
    expect(threads.view("two", "main").draft).toBe("keep me");
  });

  it("adopts an empty restarted-Gateway thread without discarding its local draft", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.hydrate("one", async () => ({
      exchanges: [{ question: "Before restart", answer: "Old answer", ts: 1 }],
    }));
    threads.setDraft("one", "unsent local draft");

    await threads.hydrate("one", async () => ({ exchanges: [] }));

    expect(threads.view("one")).toMatchObject({
      draft: "unsent local draft",
      turns: [],
    });
  });

  it.each(["resolve", "reject"] as const)(
    "does not resurrect a reset request after a late $outcome",
    async (outcome) => {
      let resolveAnswer!: (value: { answer: string; ts: number }) => void;
      let rejectAnswer!: (error: Error) => void;
      const threads = new ChatSessionCompanionThreads();
      const pending = threads.submit(
        "one",
        "Will reset keep this?",
        () =>
          new Promise((resolve, reject) => {
            resolveAnswer = resolve;
            rejectAnswer = reject;
          }),
      );

      await threads.reset("one", async () => ({ ok: true as const }));
      if (outcome === "resolve") {
        resolveAnswer({ answer: "late answer", ts: 5 });
      } else {
        rejectAnswer(new Error("late error"));
      }
      await pending;

      expect(threads.view("one").turns).toMatchObject([]);
    },
  );
});

describe("ChatSessionRailElement", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(600_000);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function mount(overrides: Partial<ChatSessionRailElement> = {}) {
    const element = document.createElement("openclaw-chat-session-rail") as ChatSessionRailElement;
    element.sessionKey = "agent:main:run";
    element.digest = digest();
    element.running = true;
    element.activeRunId = "run-1";
    element.connected = true;
    Object.assign(element, overrides);
    document.body.append(element);
    await element.updateComplete;
    return element;
  }

  it("consumes only the latest visible focus intent and retires it on disconnect", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const initial = vi.fn(() => true);
    const current = vi.fn(() => true);
    const element = await mount({ presented: true, focusRequest: initial });
    element.focusRequest = current;
    await element.updateComplete;
    await vi.advanceTimersByTimeAsync(20);
    expect(initial).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(element.querySelector("textarea"));

    const hidden = vi.fn(() => true);
    element.presented = false;
    element.focusRequest = hidden;
    await element.updateComplete;
    await vi.advanceTimersByTimeAsync(20);
    expect(hidden).not.toHaveBeenCalled();

    const retired = vi.fn(() => true);
    element.presented = true;
    element.focusRequest = retired;
    await element.updateComplete;
    element.remove();
    await vi.advanceTimersByTimeAsync(20);
    expect(retired).not.toHaveBeenCalled();
  });

  it("follows changed turns while preserving a manually scrolled draft edit", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const element = await mount({ presented: true });
    const thread = element.querySelector<HTMLElement>(".chat-session-rail__thread")!;
    Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 200 });
    await vi.advanceTimersByTimeAsync(20);
    expect(thread.scrollTop).toBe(200);

    thread.scrollTop = 60;
    element.companion = { ...element.companion, draft: "A local draft" };
    await element.updateComplete;
    await vi.advanceTimersByTimeAsync(20);
    expect(thread.scrollTop).toBe(60);

    element.companion = {
      ...element.companion,
      turns: [{ question: "What changed?", status: "answered", answer: "A completed turn", ts: 1 }],
    };
    await element.updateComplete;
    Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 500 });
    await vi.advanceTimersByTimeAsync(20);
    expect(thread.scrollTop).toBe(500);
  });

  it.each([
    { phrases: [], expected: "" },
    { phrases: ["Reviewing the workspace"], expected: "· Reviewing the workspace…" },
  ])("uses the theme's pending-answer phrases: $phrases", async ({ phrases, expected }) => {
    const originalBranding = currentThemeBranding();
    setCurrentThemeBranding({ ...originalBranding, workingPhrases: phrases });
    try {
      const element = await mount({
        companion: {
          turns: [{ question: "What changed?", status: "pending", startedAt: 560_000 }],
          loading: false,
          draft: "",
        },
      });
      const phrase = element.querySelector("openclaw-working-phrase")!;
      await phrase.updateComplete;
      expect(phrase.textContent?.replace(/\s+/g, " ").trim()).toBe(expected);
    } finally {
      setCurrentThemeBranding(originalBranding);
    }
  });

  it("submits the rail composer and renders sanitized markdown answers", async () => {
    const onSubmit = vi.fn();
    const element = await mount({
      onSubmit,
      companion: {
        turns: [
          {
            question: "What changed?",
            status: "answered",
            answer: "**Only** the UI. <script>bad()</script>",
            ts: 300_000,
          },
        ],
        loading: false,
        draft: "What should I verify?",
      },
    });

    element.querySelector("form")?.dispatchEvent(new SubmitEvent("submit", { bubbles: true }));
    expect(onSubmit).toHaveBeenCalledWith("What should I verify?");
    expect(element.querySelector(".chat-session-rail__answer strong")?.textContent).toBe("Only");
    expect(element.querySelector("script")).toBeNull();
    expect(element.querySelector(".chat-session-rail__timestamp")?.textContent).toContain("as of");
  });

  it("returns focus to the rail composer after deleting its last comment", async () => {
    const onAttachmentsChange = vi.fn();
    const element = await mount({
      presented: true,
      onAttachmentsChange,
      companion: {
        turns: [],
        loading: false,
        draft: "Keep this draft",
        attachments: [
          {
            id: "rail-comment",
            mimeType: "text/plain",
            selectionAnnotation: {
              text: "Selected text",
              comment: "Explain this",
              sessionKey: "agent:main:run",
              start: 0,
              end: 13,
            },
          },
        ],
      },
    });
    const textarea = element.querySelector("textarea")!;
    await waitForSolid(() =>
      expect(element.querySelector('button[aria-label="Delete comment"]')).not.toBeNull(),
    );
    element.querySelector<HTMLButtonElement>('button[aria-label="Delete comment"]')!.click();
    expect(onAttachmentsChange).toHaveBeenCalledWith([]);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe("Keep this draft");
  });

  it("retains selected answer text while draft and presentation props update", async () => {
    const element = await mount({
      presented: true,
      companion: {
        turns: [
          {
            question: "What changed?",
            status: "answered",
            answer: "**Retained answer**",
            ts: 300_000,
          },
        ],
        loading: false,
        draft: "",
      },
    });
    const text = element.querySelector(".chat-session-rail__answer strong")!.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    element.companion = { ...element.companion, draft: "Follow up" };
    element.presented = false;
    await element.updateComplete;
    element.presented = true;
    await element.updateComplete;
    expect(selection.toString()).toBe("Retained answer");
    expect(selection.anchorNode).toBe(text);
    selection.removeAllRanges();
  });

  it.each([false, true])(
    "uses an empty-question fallback only for images (image: %s)",
    async (image) => {
      const onSubmit = vi.fn();
      const element = await mount({
        onSubmit,
        companion: {
          turns: [],
          loading: false,
          draft: "",
          attachments: [
            image
              ? { id: "image", mimeType: "image/png" }
              : {
                  id: "comment",
                  mimeType: "text/plain",
                  selectionAnnotation: {
                    text: "Selected text",
                    comment: "Explain this",
                    sessionKey: "agent:main:run",
                    start: 0,
                    end: 13,
                  },
                },
          ],
        },
      });
      expect(element.querySelector<HTMLButtonElement>(".chat-send-btn")?.disabled).toBe(!image);
      element.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true }));
      element
        .querySelector("textarea")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(onSubmit.mock.calls).toEqual(
        image ? [["What does this image show?"], ["What does this image show?"]] : [],
      );
    },
  );

  it("explains unsupported image input and retries the retained image only on user action", async () => {
    const threads = new ChatSessionCompanionThreads();
    threads.subscribe(() => {
      element.companion = { ...threads.view("one") };
    });
    const image = registerChatAttachmentPayload({
      attachment: { id: "retry-image", mimeType: "image/png", fileName: "retry.png" },
      dataUrl: "data:image/png;base64,aW1hZ2U=",
      file: new File(["image"], "retry.png", { type: "image/png" }),
    });
    const ask = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("Image input unsupported"), {
          details: { reason: "image-input-unsupported" },
          retryable: false,
        }),
      )
      .mockResolvedValue({ answer: "The image is now visible.", ts: 123 });
    let submitted: Promise<void> | undefined;
    const element = await mount({
      companion: threads.view("one"),
      onSubmit: (turn) => {
        submitted = threads.submit("one", turn, ask);
      },
    });
    try {
      threads.setAttachments("one", [image]);
      await threads.submit("one", "Explain this image", ask);
      await element.updateComplete;
      expect(element.textContent).toContain(
        "This Side chat model cannot read images. Choose an image-capable utility model, then retry.",
      );
      expect(element.textContent).not.toContain("No utility model is configured");
      expect(ask).toHaveBeenCalledOnce();
      expect(getChatAttachmentDataUrl(image)).not.toBeNull();
      threads.setDraft("one", "Keep my next question");
      await element.updateComplete;
      const retry = element.querySelector<HTMLButtonElement>(".chat-session-rail__retry");
      expect(retry).not.toBeNull();
      expect(retry?.disabled).toBe(false);
      retry!.click();
      await submitted;
      await element.updateComplete;
      expect(ask).toHaveBeenCalledTimes(2);
      expect(ask).toHaveBeenLastCalledWith("one", "Explain this image", [image]);
      expect(element.textContent).toContain("The image is now visible.");
      expect(element.querySelector(".chat-session-rail__retry")).toBeNull();
      expect(threads.view("one").draft).toBe("Keep my next question");
      expect(getChatAttachmentDataUrl(image)).toBeNull();
    } finally {
      threads.retire();
    }
  });

  it.each(["answered"] as const)(
    "keeps a follow-up editable while answering and retains it when %s",
    async (outcome) => {
      const threads = new ChatSessionCompanionThreads();
      threads.subscribe(() => {
        element.companion = { ...threads.view("one") };
      });
      const ask = vi.fn<() => Promise<{ answer: string; ts: number }>>();
      let resolveAnswer!: (value: { answer: string; ts: number }) => void;
      let rejectAnswer!: (error: Error) => void;
      ask.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            resolveAnswer = resolve;
            rejectAnswer = reject;
          }),
      );
      let submission: Promise<void> | undefined;
      const element = await mount({
        companion: threads.view("one"),
        onDraftChange: (draft) => threads.setDraft("one", draft),
        onSubmit: (question) => {
          submission = threads.submit("one", question, ask);
        },
      });
      const textarea = element.querySelector<HTMLTextAreaElement>("textarea")!;
      const send = element.querySelector<HTMLButtonElement>(".chat-send-btn")!;
      const type = async (draft: string) => {
        textarea.value = draft;
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
        await element.updateComplete;
      };
      const enter = () =>
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
      expect(send.disabled).toBe(true);
      await type("What changed?");
      expect(send.disabled).toBe(false);
      const compositionEnd = new CompositionEvent("compositionend", { bubbles: true });
      textarea.dispatchEvent(compositionEnd);
      const confirmingEnter = new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 13,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(confirmingEnter, "timeStamp", {
        value: compositionEnd.timeStamp - 1,
      });
      textarea.dispatchEvent(confirmingEnter);
      expect(confirmingEnter.defaultPrevented).toBe(false);
      expect(ask).not.toHaveBeenCalled();
      expect(textarea.value).toBe("What changed?");
      textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      enter();
      await element.updateComplete;
      expect(textarea.disabled).toBe(false);
      expect(textarea.value).toBe("");
      expect(textarea.placeholder).toBe("Ask a question");
      await type("What should I verify next?");
      expect(send.disabled).toBe(true);
      enter();
      element.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true }));
      expect(ask).toHaveBeenCalledTimes(1);
      expect(textarea.value).toBe("What should I verify next?");
      if (outcome === "answered") {
        resolveAnswer({ answer: "The composer changed.", ts: 42 });
      } else {
        rejectAnswer(new Error("Side chat timed out."));
      }
      await submission;
      await element.updateComplete;
      expect(threads.view("one").turns[0]?.status).toBe(outcome);
      expect(textarea.value).toBe("What should I verify next?");
      expect(send.disabled).toBe(false);
      element.connected = false;
      await element.updateComplete;
      expect(textarea.disabled).toBe(true);
      expect(send.disabled).toBe(true);
      element.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true }));
      expect(ask).toHaveBeenCalledTimes(1);
      element.connected = true;
      await element.updateComplete;
      expect(textarea.disabled).toBe(false);
      expect(textarea.value).toBe("What should I verify next?");
      expect(send.disabled).toBe(false);
    },
  );

  it("shows the shared chat skeleton instead of the empty state during hydration", async () => {
    const element = await mount({
      companion: {
        turns: [],
        loading: true,
        draft: "",
      },
    });

    const skeleton = element.querySelector("openclaw-panel-loading-skeleton");
    expect(skeleton?.getAttribute("data-panel-skeleton")).toBe("chat");
    expect(element.querySelector("openclaw-panel-empty-state")).toBeNull();
  });

  it("offers starter questions instead of an empty thread, and asks the tapped one", async () => {
    const onSubmit = vi.fn();
    const element = await mount({ onSubmit });

    const starters = [...element.querySelectorAll(".chat-session-rail__starter")];
    expect(starters.map((starter) => starter.textContent?.trim())).toEqual([
      "What changed?",
      "Why did it stop?",
      "What's left?",
    ]);

    (starters[1] as HTMLButtonElement).click();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Why did it stop?");
  });
});
