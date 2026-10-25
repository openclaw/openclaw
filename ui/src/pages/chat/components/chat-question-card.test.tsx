/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { scheduleTextareaHeightAdjustment } from "./chat-composer-dom.ts";
import { QuestionFreeText } from "./chat-question-answer-controls.tsx";
import { createGatewayQuestionPanelProps } from "./chat-question-card.ts";
import type { QuestionPanelProps } from "./chat-question-card.ts";
import { ChatQuestionPanel } from "./chat-question-panel.tsx";
import { subscribeTranscriptScroll } from "./chat-transcript-scroll-events.ts";

function gatewayPrompt(overrides: Partial<QuestionPrompt> = {}): QuestionPrompt {
  return {
    id: "question-1",
    questions: [
      {
        questionId: "format",
        header: "Format",
        question: "Which format should I use?",
        options: [
          { label: "Compact", description: "Keep it brief" },
          { label: "Detailed", description: "Include rationale" },
        ],
        isOther: true,
      },
    ],
    sessionKey: "agent:main:main",
    createdAtMs: 1_000,
    expiresAtMs: 62_000,
    status: "pending",
    answeredElsewhere: false,
    localResolutionConfirmed: false,
    locallyExpired: false,
    submitting: false,
    error: null,
    drafts: new Map(),
    revision: 1,
    ...overrides,
  };
}

function freeTextQuestion(
  overrides: Partial<QuestionPrompt["questions"][number]> = {},
): QuestionPrompt["questions"][number] {
  return {
    questionId: "value",
    header: "Value",
    question: "Provide a value",
    options: [],
    ...overrides,
  };
}

async function panelIn(container: HTMLElement): Promise<HTMLElement> {
  flush();
  await waitForSolid(() => expect(container.querySelector(".chat-question-panel")).not.toBeNull());
  return container.querySelector<HTMLElement>("openclaw-chat-question-panel")!;
}

describe("shared question panel", () => {
  let container: HTMLDivElement;
  let mounted: ReturnType<typeof mountSolid> | undefined;
  let setPanel: ((value: QuestionPanelProps) => void) | undefined;
  function drawPanel(props: QuestionPanelProps) {
    if (!mounted) {
      const [panel, updatePanel] = createSignal(props);
      setPanel = updatePanel;
      mounted = mountSolid(() => <ChatQuestionPanel props={panel()} />, { container });
    } else {
      setPanel!(props);
    }
    flush();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    setPanel = undefined;
    container.remove();
  });

  function drawGateway(
    prompt: QuestionPrompt,
    callbacks: {
      onSubmit?: (answers: Record<string, string[]>) => void | Promise<void>;
      onSkip?: () => void | Promise<void>;
    } = {},
  ) {
    let collapsed = false;
    const redraw = () => {
      drawPanel(
        createGatewayQuestionPanelProps(prompt, {
          collapsed,
          onCollapsedChange: (nextCollapsed) => {
            collapsed = nextCollapsed;
            redraw();
          },
          onChange: redraw,
          onSubmit: callbacks.onSubmit ?? vi.fn(),
          onSkip: callbacks.onSkip ?? vi.fn(),
        }),
      );
    };
    redraw();
  }

  const query = <T extends Element = HTMLElement>(selector: string) =>
    container.querySelector<T>(selector);
  const part = (name: string) => query(`.chat-question-panel__${name}`);
  const button = (name: string) => query<HTMLButtonElement>(`.chat-question-panel__${name}`)!;
  const field = (selector = "textarea") => query<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    element.value = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flush();
  };
  async function show(prompt = gatewayPrompt(), callbacks: Parameters<typeof drawGateway>[1] = {}) {
    drawGateway(prompt, callbacks);
    await panelIn(container);
    return query(".chat-question-panel")!;
  }

  it("keeps answer sizing on the live transcript without disturbing native editing", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = document.createElement("div");
    const second = document.createElement("div");
    const replacement = document.createElement("div");
    const observed = [vi.fn(), vi.fn(), vi.fn()];
    const stops = [first, second, replacement].map((element, index) =>
      subscribeTranscriptScroll(element, observed[index]!),
    );
    let transcript = first;
    let replaceGetter!: () => void;
    mounted = mountSolid(
      () => {
        const [value, setValue] = createSignal("alpha");
        const [source, setSource] = createSignal({ get: () => transcript });
        replaceGetter = () => setSource({ get: () => replacement });
        return (
          <QuestionFreeText
            question={freeTextQuestion()}
            value={value()}
            selected={false}
            disabled={false}
            getTranscriptElement={source().get}
            onInput={setValue}
          />
        );
      },
      { container },
    );
    try {
      flush();
      const textarea = container.querySelector("textarea")!;
      textarea.focus();
      textarea.value = "alpha beta";
      textarea.setSelectionRange(2, 2);
      observed.forEach((observer) => observer.mockClear());
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
      flush();
      expect(observed[0]).toHaveBeenCalledWith({ type: "before-resize" });
      expect(document.activeElement).toBe(textarea);
      expect(textarea.selectionStart).toBe(2);
      expect(textarea.selectionEnd).toBe(2);
      expect(container.querySelector("textarea")).toBe(textarea);

      transcript = second;
      scheduleTextareaHeightAdjustment(textarea);
      await Promise.resolve();
      expect(observed[1]).toHaveBeenCalledWith({ type: "before-resize" });
      replaceGetter();
      flush();
      expect(observed[2]).toHaveBeenCalledWith({ type: "before-resize" });
      expect(container.querySelector("textarea")).toBe(textarea);
      expect(
        warnings.mock.calls.filter(([text]) => String(text).includes("STRICT_READ_UNTRACKED")),
      ).toEqual([]);
    } finally {
      stops.forEach((stop) => stop());
      warnings.mockRestore();
    }
  });

  it("steps from single-select to multi-select and preserves array answers", async () => {
    const prompt = gatewayPrompt({
      questions: [
        freeTextQuestion({
          questionId: "target",
          question: "Where should I send it?",
          options: [{ label: "Chat" }, { label: "File" }],
          isOther: true,
        }),
        freeTextQuestion({
          questionId: "extras",
          question: "Which extras should I include?",
          options: [{ label: "Tests" }, { label: "Docs" }],
          multiSelect: true,
          isOther: true,
        }),
      ],
    });
    const onSubmit = vi.fn();
    await show(prompt, { onSubmit });

    expect(query('[role="radiogroup"]')).not.toBeNull();
    expect(field(".chat-question-panel__option--other textarea").placeholder).toBe(
      "Type your own answer here",
    );
    expect(part("progress")?.textContent).toBe("1/2");
    query<HTMLButtonElement>('[role="radio"]')?.click();
    flush();

    expect(part("prompt")?.textContent).toBe("Which extras should I include?");
    expect(part("progress")?.textContent).toBe("2/2");
    expect(document.activeElement).toBe(query(".chat-question-panel"));
    button("back").click();
    flush();
    expect(part("prompt")?.textContent).toBe("Where should I send it?");
    query<HTMLButtonElement>('[role="radio"]')?.click();
    flush();
    container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[0]?.click();
    container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[1]?.click();
    type(field(".chat-question-panel__other"), "Metrics");
    button("advance").click();

    expect(onSubmit).toHaveBeenCalledWith({
      target: ["Chat"],
      extras: ["Tests", "Docs", "Metrics"],
    });
  });

  it("renders thumbnail fallbacks and submits suggested plus multiple custom array entries", async () => {
    const prompt = gatewayPrompt({
      questions: [
        freeTextQuestion({
          questionId: "parts",
          presentation: "form",
          multiSelect: true,
          isOther: true,
          answerFormat: "lines",
          defaultAnswers: ["washer"],
          options: [
            {
              label: "Washer",
              value: "washer",
              thumbnail: "data:image/png;base64,aW1hZ2U=",
              description: "Fits the joint",
            },
            { label: "Bolt" },
            { label: "Remote washer", thumbnail: "https://example.com/washer.png" },
          ],
        }),
      ],
    });
    const onSubmit = vi.fn();
    await show(prompt, { onSubmit });
    expect(container.querySelectorAll(".chat-question-panel__thumbnail")).toHaveLength(3);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    const image = container.querySelector<HTMLImageElement>(".chat-question-panel__thumbnail img");
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    const link = query<HTMLAnchorElement>(".chat-question-panel__external-image");
    expect(link?.href).toBe("https://example.com/washer.png");
    expect(link?.rel).toBe("noreferrer noopener");
    expect(container.querySelector('[aria-checked="true"]')?.textContent).toContain("Washer");
    type(field(".chat-question-panel__other"), "custom-spacer\ncustom-gasket");
    button("advance").click();
    expect(onSubmit).toHaveBeenCalledWith({ parts: ["washer", "custom-spacer", "custom-gasket"] });
  });

  it("renders resource forms without a free-text URI fallback", async () => {
    await show(
      gatewayPrompt({
        questions: [
          freeTextQuestion({
            presentation: "form",
            isOther: true,
            resource: {
              viewId: "mcp-app-form",
              selection: "implicit",
              userOptions: { kind: "file" },
            },
          }),
        ],
      }),
    );
    expect(query("textarea")).toBeNull();
    expect(query('input[type="file"]')).not.toBeNull();
  });

  it("remasks secrets when moving to another question or request", async () => {
    const submitted = createDeferred();
    const onSubmit = vi.fn(() => submitted.promise);
    const secret = "  fake-secret-first  ";
    const prompt = gatewayPrompt({
      questions: [
        freeTextQuestion({ questionId: "first", isSecret: true }),
        freeTextQuestion({ questionId: "second", isSecret: true }),
      ],
    });
    await show(prompt, { onSubmit });
    const input = () => field("input");
    const reveal = () => {
      query<HTMLButtonElement>('button[aria-label="Show secret"]')!.click();
      flush();
    };
    type(input(), secret);
    reveal();
    expect(input().type).toBe("text");
    button("advance").click();
    flush();
    expect(input().type).toBe("password");
    expect(input().value).toBe("");
    type(input(), "second-secret");
    button("advance").click();
    expect(onSubmit).toHaveBeenCalledWith({ first: [secret], second: ["second-secret"] });
    await waitForSolid(() => expect(button("back").disabled).toBe(true));
    submitted.resolve();
    await waitForSolid(() => expect(button("back").disabled).toBe(false));
    button("back").click();
    flush();
    expect(input().type).toBe("password");
    expect(input().value).toBe(secret);
    reveal();
    await show(gatewayPrompt({ id: "question-2", questions: prompt.questions }));
    expect(input().type).toBe("password");
    expect(input().value).toBe("");
  });

  it.each([
    { field: "text answer", selector: "textarea", isSecret: false },
    { field: "password answer", selector: 'input[type="password"]', isSecret: true },
    { field: "destination hosts", selector: ".chat-question-panel__hosts", isSecret: true },
  ])(
    "preserves focus in $field across controlled draft updates",
    async ({ selector, isSecret }) => {
      await show(
        gatewayPrompt({
          questions: [
            freeTextQuestion({
              isSecret,
              secretStore: isSecret
                ? { name: "FAKE_API_KEY", kind: "secret", allowedHosts: [] }
                : undefined,
            }),
          ],
        }),
      );
      const input = field(selector);
      input.focus();

      for (const value of ["a", "ab"]) {
        type(input, value);

        expect(document.activeElement).toBe(input);
        expect(input.value).toBe(value);
      }
    },
  );

  it("keeps environment store requests masked without exposing a destination-host editor", async () => {
    await show(
      gatewayPrompt({
        questions: [
          freeTextQuestion({
            isSecret: true,
            secretStore: { name: "FAKE_ENVIRONMENT_VALUE", kind: "env" },
          }),
        ],
      }),
    );
    expect(query('input[type="password"]')).not.toBeNull();
    expect(part("hosts")).toBeNull();
    expect(container.textContent).toContain(
      "Stores FAKE_ENVIRONMENT_VALUE as Agent-readable environment",
    );
  });

  it("leaves modified numeric shortcuts to the browser", async () => {
    const onSubmit = vi.fn();
    const group = await show(gatewayPrompt(), { onSubmit });

    group.dispatchEvent(new KeyboardEvent("keydown", { key: "2", ctrlKey: true, bubbles: true }));
    flush();

    expect(query('[aria-checked="true"]')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("labels optionless free text without exposing an Other shortcut", async () => {
    const group = await show(
      gatewayPrompt({ questions: [freeTextQuestion({ header: "", isOther: true })] }),
    );
    const input = field("input, textarea");
    expect(input.labels?.[0]?.textContent).toContain("Answer");
    expect(input.placeholder).toBe("Answer");
    const event = new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true });

    group.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("uses roving radio focus and arrow-key selection", async () => {
    await show(
      gatewayPrompt({
        questions: [
          ...gatewayPrompt().questions,
          freeTextQuestion({
            options: [{ label: "Ready" }],
            isOther: false,
          }),
        ],
      }),
    );
    const radios = container.querySelectorAll<HTMLButtonElement>('[role="radio"]');

    expect([...radios].map((radio) => radio.tabIndex)).toEqual([0, -1]);
    radios[0]?.focus();
    radios[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    flush();

    const updated = container.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect([...updated].map((radio) => radio.tabIndex)).toEqual([-1, 0]);
    expect(updated[1]?.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(updated[1]);
    expect(part("prompt")?.textContent).toBe("Which format should I use?");
  });

  it("leaves IME Ctrl+Enter editing to the textarea", async () => {
    const onSubmit = vi.fn();
    await show(gatewayPrompt(), { onSubmit });
    const other = field();
    type(other, "A draft that is not ready");
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    other.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[aria-checked="true"]')).toHaveLength(0);
  });

  it("uses Ctrl+Enter in Other to submit a multiline answer", async () => {
    const onSubmit = vi.fn();
    await show(gatewayPrompt(), { onSubmit });
    const other = field(".chat-question-panel__other");

    other.value = "Markdown table\nInclude the tradeoffs.";
    other.dispatchEvent(new InputEvent("input", { bubbles: true }));
    other.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
    );
    flush();

    expect(onSubmit).toHaveBeenCalledWith({ format: ["Markdown table\nInclude the tradeoffs."] });
  });

  it("collapses without answering and exposes gateway cancellation through Skip", async () => {
    const onSkip = vi.fn();
    await show(gatewayPrompt(), { onSkip });

    button("collapse").click();
    flush();
    expect(query(".chat-question-panel--collapsed")?.textContent).toContain("Format");
    expect(onSkip).not.toHaveBeenCalled();

    button("collapsed-button").click();
    flush();
    expect(document.activeElement).toBe(query(".chat-question-panel"));
    button("skip").click();
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("honors autofocus opt-out and manages uncontrolled collapse and expansion", async () => {
    const props = createGatewayQuestionPanelProps(gatewayPrompt(), {});
    drawPanel({ ...props, model: { ...props.model, autoFocus: false } });
    await panelIn(container);
    expect(document.activeElement).toBe(document.body);

    button("collapse").click();
    flush();
    expect(query(".chat-question-panel--collapsed")).not.toBeNull();
    button("collapsed-button").click();
    flush();
    expect(query(".chat-question-panel--collapsed")).toBeNull();
    expect(document.activeElement).toBe(query(".chat-question-panel"));
  });

  it("keeps a newer submission locked when an older visit to the same question settles", async () => {
    const older = createDeferred();
    const newer = createDeferred();
    const onSubmit = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const prompt = gatewayPrompt();
    await show(prompt, { onSubmit });
    query<HTMLButtonElement>('[role="radio"]')!.click();
    flush();
    const firstButton = button("advance");
    firstButton.click();
    firstButton.click();
    await waitForSolid(() => expect(firstButton.disabled).toBe(true));
    expect(onSubmit).toHaveBeenCalledTimes(1);

    drawGateway(gatewayPrompt({ id: "another-question" }));
    await waitForSolid(() => {
      expect(part("advance")).not.toBe(firstButton);
    });
    drawGateway(prompt, { onSubmit });
    flush();
    const currentButton = button("advance");
    currentButton.click();
    flush();
    older.resolve();
    await older.promise;
    flush();
    expect(currentButton.disabled).toBe(true);
    newer.reject(new Error("Question submission failed"));
    await waitForSolid(() => expect(currentButton.disabled).toBe(false));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    currentButton.click();
    expect(onSubmit).toHaveBeenCalledTimes(3);
    expect(onSubmit).toHaveBeenLastCalledWith({ format: ["Compact"] });
  });
});
