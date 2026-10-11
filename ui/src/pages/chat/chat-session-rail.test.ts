/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import {
  ChatSessionCompanionThreads,
  requestSessionCompanionAnswer,
} from "./chat-session-companion.ts";
import { ChatSessionRailElement } from "./components/chat-session-rail.ts";

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

  it("hydrates and retains independent per-session threads", async () => {
    const threads = new ChatSessionCompanionThreads();
    const load = vi.fn(async (sessionKey: string) => ({
      exchanges: [
        {
          question: `Question for ${sessionKey}`,
          answer: `Answer for ${sessionKey}`,
          ts: sessionKey === "one" ? 1 : 2,
        },
      ],
    }));

    await threads.hydrate("one", load);
    await threads.hydrate("two", load);

    expect(threads.view("one").turns).toMatchObject([
      { question: "Question for one", status: "answered", answer: "Answer for one", ts: 1 },
    ]);
    expect(threads.view("two").turns).toMatchObject([
      { question: "Question for two", status: "answered", answer: "Answer for two", ts: 2 },
    ]);
  });

  it("records hydration until the authoritative companion state settles", async () => {
    let resolveLoad!: (value: { exchanges: [] }) => void;
    const threads = new ChatSessionCompanionThreads();
    const pending = threads.hydrate(
      "one",
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );

    expect(threads.view("one").loading).toBe(true);
    resolveLoad({ exchanges: [] });
    await pending;
    expect(threads.view("one").loading).toBe(false);
  });

  it("keeps matching bare session keys isolated by agent", () => {
    const threads = new ChatSessionCompanionThreads();
    threads.setDraft("global", "main draft", "main");
    threads.setDraft("global", "work draft", "work");

    expect(threads.view("global", "main").draft).toBe("main draft");
    expect(threads.view("global", "work").draft).toBe("work draft");
  });

  it("moves a composer submission through pending to a timestamped answer", async () => {
    let resolveAnswer!: (value: { answer: string; ts: number }) => void;
    const threads = new ChatSessionCompanionThreads();
    threads.setDraft("one", "Why is it rerunning that test?");
    const pending = threads.submit(
      "one",
      threads.view("one").draft,
      () =>
        new Promise((resolve) => {
          resolveAnswer = resolve;
        }),
    );

    expect(threads.view("one").turns).toMatchObject([
      { question: "Why is it rerunning that test?", status: "pending" },
    ]);
    expect(threads.view("one").draft).toBe("");
    resolveAnswer({ answer: "It is verifying the focused regression.", ts: 42 });
    await pending;

    expect(threads.view("one")).toMatchObject({
      turns: [
        {
          question: "Why is it rerunning that test?",
          status: "answered",
          answer: "It is verifying the focused regression.",
          ts: 42,
        },
      ],
    });
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

  it("preserves a context failure for an explicit retry", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "What changed?", async () => {
      throw Object.assign(new Error("history unavailable"), {
        details: { reason: "context-unavailable" },
        retryable: true,
      });
    });

    expect(threads.view("one").turns).toMatchObject([
      { question: "What changed?", status: "failed", hint: "history-unavailable", retryable: true },
    ]);
    await threads.hydrate("one", async () => ({ exchanges: [] }));
    expect(threads.view("one").turns).toMatchObject([
      { question: "What changed?", status: "failed", hint: "history-unavailable", retryable: true },
    ]);
  });

  it.each([
    { reason: "rate-limited", retryable: true, hint: "rate-limited" },
    { reason: "utility-model-unavailable", retryable: false, hint: "model-unavailable" },
    { reason: "unavailable", retryable: false, hint: "unavailable" },
  ] as const)("maps $reason to its specific retry state", async (expected) => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "What changed?", async () => {
      throw Object.assign(new Error(expected.reason), {
        details: { reason: expected.reason },
        retryable: expected.retryable,
      });
    });

    expect(threads.view("one").turns).toMatchObject([
      {
        question: "What changed?",
        status: "failed",
        hint: expected.hint,
        retryable: expected.retryable,
      },
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

  it("uses the shared surface empty state before the first side-chat exchange", async () => {
    const element = await mount();
    const empty = element.querySelector("openclaw-panel-empty-state");
    await empty?.updateComplete;

    expect(empty?.querySelector(".empty-state__title")?.textContent).toBe("Side chat");
    expect(empty?.querySelector("svg")).not.toBeNull();
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
    const threads = new ChatSessionCompanionThreads(() => {
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

  it("renders one pending state and retries a retryable failure", async () => {
    const onSubmit = vi.fn();
    const element = await mount({
      onSubmit,
      companion: {
        turns: [{ question: "What changed?", status: "pending" }],
        loading: false,
        draft: "",
      },
    });
    expect(element.textContent).toContain("Answering from this session…");

    element.companion = {
      turns: [
        {
          question: "What changed?",
          status: "failed",
          hint: "history-unavailable",
          retryable: true,
        },
      ],
      loading: false,
      draft: "",
    };
    await element.updateComplete;
    expect(element.textContent).toContain("Couldn't load this session's history.");
    expect(element.querySelector("openclaw-panel-empty-state")).toBeNull();
    (element.querySelector(".chat-session-rail__retry") as HTMLButtonElement).click();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(element.companion.turns[0]);
    expect(onSubmit.mock.calls[0]?.[0]).toBe(element.companion.turns[0]);
  });

  it.each(["answered", "failed"] as const)(
    "keeps a follow-up editable while answering and retains it when %s",
    async (outcome) => {
      const threads = new ChatSessionCompanionThreads(() => {
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
    await skeleton?.updateComplete;
    expect(skeleton?.getAttribute("data-panel-skeleton")).toBe("chat");
    expect(element.querySelector("openclaw-panel-empty-state")).toBeNull();
  });

  it("keeps live announcements scoped to the message thread", async () => {
    const element = await mount();
    const section = element.querySelector(".chat-session-rail--expanded");
    expect(section?.hasAttribute("aria-live")).toBe(false);
    expect(element.querySelector(".chat-session-rail__thread")?.getAttribute("aria-live")).toBe(
      "polite",
    );
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

  it("replaces the starters once the thread has an exchange", async () => {
    const element = await mount({
      companion: {
        turns: [
          {
            question: "What changed?",
            status: "answered",
            answer: "The rail toggle.",
            ts: 300_000,
          },
        ],
        loading: false,
        draft: "",
      },
    });

    expect(element.querySelector(".chat-session-rail__starter")).toBeNull();
    expect(element.querySelector(".chat-session-rail__exchange")).not.toBeNull();
  });
});
