/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createGatewayQuestionPanelProps } from "./chat-question-card.ts";
import type { QuestionPanelProps } from "./chat-question-card.ts";
import { ChatQuestionPanel } from "./chat-question-panel.tsx";

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

  function drawUncontrolled(options: Parameters<typeof createGatewayQuestionPanelProps>[1]) {
    drawPanel(createGatewayQuestionPanelProps(gatewayPrompt(), options));
    return panelIn(container);
  }

  it("steps from single-select to multi-select and preserves array answers", async () => {
    const prompt = gatewayPrompt({
      questions: [
        {
          questionId: "target",
          header: "Target",
          question: "Where should I send it?",
          options: [{ label: "Chat" }, { label: "File" }],
          isOther: true,
        },
        {
          questionId: "extras",
          header: "Extras",
          question: "Which extras should I include?",
          options: [{ label: "Tests" }, { label: "Docs" }],
          multiSelect: true,
          isOther: true,
        },
      ],
    });
    const onSubmit = vi.fn();
    drawGateway(prompt, { onSubmit });
    await panelIn(container);

    expect(
      container.querySelector('[role="radio"] .chat-question-panel__option-marker'),
    ).not.toBeNull();
    expect(container.querySelector('[role="radio"] kbd')).not.toBeNull();
    expect(
      container.querySelector(
        ".chat-question-panel__option--other .chat-question-panel__option-marker",
      ),
    ).not.toBeNull();
    expect(container.querySelector(".chat-question-panel__option--other kbd")).not.toBeNull();
    expect(container.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(
      container.querySelector<HTMLTextAreaElement>(".chat-question-panel__option--other textarea")
        ?.placeholder,
    ).toBe("Type your own answer here");
    expect(container.querySelector(".chat-question-panel__progress")?.textContent).toBe("1/2");
    container.querySelector<HTMLButtonElement>('[role="radio"]')?.click();
    flush();

    expect(container.querySelector(".chat-question-panel__prompt")?.textContent).toBe(
      "Which extras should I include?",
    );
    expect(container.querySelector(".chat-question-panel__progress")?.textContent).toBe("2/2");
    expect(document.activeElement).toBe(container.querySelector(".chat-question-panel"));
    container.querySelector<HTMLButtonElement>(".chat-question-panel__back")?.click();
    flush();
    expect(container.querySelector(".chat-question-panel__prompt")?.textContent).toBe(
      "Where should I send it?",
    );
    container.querySelector<HTMLButtonElement>('[role="radio"]')?.click();
    flush();
    container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[0]?.click();
    container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[1]?.click();
    const other = container.querySelector<HTMLTextAreaElement>(".chat-question-panel__other")!;
    other.value = "Metrics";
    other.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flush();
    container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")?.click();

    expect(onSubmit).toHaveBeenCalledWith({
      target: ["Chat"],
      extras: ["Tests", "Docs", "Metrics"],
    });
  });

  it("renders thumbnail fallbacks and submits suggested plus multiple custom array entries", async () => {
    const prompt = gatewayPrompt({
      questions: [
        {
          questionId: "parts",
          header: "Parts",
          question: "Select parts",
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
          ],
        },
      ],
    });
    const onSubmit = vi.fn();
    drawGateway(prompt, { onSubmit });
    await panelIn(container);
    expect(container.querySelectorAll(".chat-question-panel__thumbnail")).toHaveLength(2);
    const image = container.querySelector<HTMLImageElement>(".chat-question-panel__thumbnail img");
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(container.querySelector('[aria-checked="true"]')?.textContent).toContain("Washer");
    const input = container.querySelector<HTMLTextAreaElement>(".chat-question-panel__other")!;
    input.value = "custom-spacer\ncustom-gasket";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flush();
    container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")?.click();
    expect(onSubmit).toHaveBeenCalledWith({ parts: ["washer", "custom-spacer", "custom-gasket"] });
  });

  it("does not automatically load remote form thumbnails", async () => {
    drawGateway(
      gatewayPrompt({
        questions: [
          {
            questionId: "part",
            header: "Part",
            question: "Choose a part",
            presentation: "form",
            options: [{ label: "Washer", thumbnail: "https://example.com/washer.png" }],
          },
        ],
      }),
    );
    await panelIn(container);
    expect(container.querySelector("img")).toBeNull();
    const link = container.querySelector<HTMLAnchorElement>(".chat-question-panel__external-image");
    expect(link?.href).toBe("https://example.com/washer.png");
    expect(link?.rel).toBe("noreferrer noopener");
  });

  it("removes implicit resource selections and never substitutes a free-text URI input", async () => {
    const onSubmit = vi.fn();
    drawGateway(
      gatewayPrompt({
        questions: [
          {
            questionId: "parts",
            header: "Parts",
            question: "Keep resources",
            presentation: "form",
            multiSelect: true,
            isOther: true,
            allowEmpty: true,
            defaultAnswers: ["Washer"],
            resource: {
              viewId: "mcp-app-form",
              selection: "implicit",
              userOptions: { kind: "file" },
            },
            options: [{ label: "Washer", resourceUri: "cad://parts/washer" }],
          },
        ],
      }),
      { onSubmit },
    );
    await panelIn(container);
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
    container.querySelector<HTMLButtonElement>('[aria-label="Remove Washer"]')?.click();
    flush();
    expect(container.querySelector('[data-option-index="0"]')).toBeNull();
    container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")?.click();
    expect(onSubmit).toHaveBeenCalledWith({ parts: [] });
  });

  it("keeps a store-bound secret masked while preserving editable destination hosts", async () => {
    const prompt = gatewayPrompt({
      agentId: "release-agent",
      questions: [
        {
          questionId: "api_key",
          header: "API key",
          question: "Provide the deployment API key",
          options: [],
          isSecret: true,
          secretStore: {
            name: "FAKE_DEPLOYMENT_API_KEY",
            kind: "secret",
            allowedHosts: ["api.example.test"],
            reason: "Deploy the approved release",
          },
          secretStoreExisting: {
            updatedAtMs: Date.now() - 60_000,
            updatedBy: "release-owner",
          },
        },
      ],
    });
    const onSubmit = vi.fn();
    drawGateway(prompt, { onSubmit });
    await panelIn(container);
    const hosts = container.querySelector<HTMLInputElement>(".chat-question-panel__hosts")!;
    const secret = container.querySelector<HTMLInputElement>('input[type="password"]')!;

    expect(hosts.value).toBe("api.example.test");
    expect(secret.autocomplete).toBe("off");
    expect(secret.placeholder).toBe("FAKE_DEPLOYMENT_API_KEY");
    expect(secret.closest("label")?.textContent).toContain("API key");
    expect(container.querySelector(".chat-question-panel__options")).toBeNull();
    expect(container.querySelector(".chat-question-panel__option-marker")).toBeNull();
    expect(container.querySelector("kbd")).toBeNull();
    expect(container.textContent).toContain("release-agent");
    expect(container.textContent).toContain("agent:main:main");
    expect(container.textContent).toContain("Stores FAKE_DEPLOYMENT_API_KEY as Protected secret");
    expect(container.textContent).toContain("Deploy the approved release");
    expect(container.textContent).toContain("Replaces FAKE_DEPLOYMENT_API_KEY — last updated");
    expect(container.textContent).toContain("by release-owner");

    hosts.value = "api.example.test, uploads.example.test";
    hosts.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flush();
    expect(prompt.secretStoreAllowedHostsDraft).toBe("api.example.test, uploads.example.test");

    const fakeSecret = "  fake-secret-value-for-ui-test  ";
    secret.value = fakeSecret;
    secret.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flush();
    expect(prompt.drafts.get("api_key")?.freeText).toBe(fakeSecret);
    expect(secret.value).toBe(fakeSecret);
    expect(container.textContent).not.toContain(fakeSecret);
    expect(container.innerHTML).not.toContain(fakeSecret);

    container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")?.click();
    expect(onSubmit).toHaveBeenCalledWith({ api_key: [fakeSecret] });
  });

  it.each([
    { field: "text answer", selector: "textarea", isSecret: false },
    { field: "password answer", selector: 'input[type="password"]', isSecret: true },
    { field: "destination hosts", selector: ".chat-question-panel__hosts", isSecret: true },
  ])(
    "preserves focus in $field across controlled draft updates",
    async ({ selector, isSecret }) => {
      drawGateway(
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
      await panelIn(container);
      const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
      input.focus();

      for (const value of ["a", "ab"]) {
        input.value = value;
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        flush();

        expect(document.activeElement).toBe(input);
        expect(input.value).toBe(value);
      }
    },
  );

  it("labels optionless answers when the compact header is empty", async () => {
    drawGateway(
      gatewayPrompt({
        questions: [freeTextQuestion({ header: "" })],
      }),
    );
    await panelIn(container);

    const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      "input, textarea",
    )!;
    expect(input.closest("label")?.textContent).toContain("Answer");
    expect(input.placeholder).toBe("Answer");
  });

  it("keeps environment store requests masked without exposing a destination-host editor", async () => {
    drawGateway(
      gatewayPrompt({
        questions: [
          {
            questionId: "environment_value",
            header: "Environment",
            question: "Provide the environment value",
            options: [],
            isSecret: true,
            secretStore: { name: "FAKE_ENVIRONMENT_VALUE", kind: "env" },
          },
        ],
      }),
    );
    await panelIn(container);

    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.querySelector(".chat-question-panel__hosts")).toBeNull();
    expect(container.textContent).toContain(
      "Stores FAKE_ENVIRONMENT_VALUE as Agent-readable environment",
    );
  });

  it("supports numeric selection and Enter submission while focused", async () => {
    const onSubmit = vi.fn();
    drawGateway(gatewayPrompt(), { onSubmit });
    await panelIn(container);
    const group = container.querySelector<HTMLElement>(".chat-question-panel")!;

    group.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    flush();
    expect(
      container.querySelectorAll<HTMLElement>('[role="radio"]')[1]?.getAttribute("aria-checked"),
    ).toBe("true");

    group.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSubmit).toHaveBeenCalledWith({ format: ["Detailed"] });
  });

  it("leaves modified numeric shortcuts to the browser", async () => {
    const onSubmit = vi.fn();
    drawGateway(gatewayPrompt(), { onSubmit });
    await panelIn(container);
    const group = container.querySelector<HTMLElement>(".chat-question-panel")!;

    group.dispatchEvent(new KeyboardEvent("keydown", { key: "2", ctrlKey: true, bubbles: true }));
    flush();

    expect(container.querySelector('[aria-checked="true"]')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not expose an Other shortcut for optionless free text", async () => {
    drawGateway(
      gatewayPrompt({
        questions: [freeTextQuestion({ isOther: true })],
      }),
    );
    await panelIn(container);
    const group = container.querySelector<HTMLElement>(".chat-question-panel")!;
    const event = new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true });

    group.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("uses roving radio focus and arrow-key selection", async () => {
    drawGateway(
      gatewayPrompt({
        questions: [
          ...gatewayPrompt().questions,
          {
            questionId: "confirm",
            header: "Confirm",
            question: "Ready to continue?",
            options: [{ label: "Ready" }],
            isOther: false,
          },
        ],
      }),
    );
    await panelIn(container);
    const radios = container.querySelectorAll<HTMLButtonElement>('[role="radio"]');

    expect([...radios].map((radio) => radio.tabIndex)).toEqual([0, -1]);
    radios[0]?.focus();
    radios[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    flush();

    const updated = container.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect([...updated].map((radio) => radio.tabIndex)).toEqual([-1, 0]);
    expect(updated[1]?.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(updated[1]);
    expect(container.querySelector(".chat-question-panel__prompt")?.textContent).toBe(
      "Which format should I use?",
    );
  });

  it("leaves IME Ctrl+Enter editing to the textarea", async () => {
    const onSubmit = vi.fn();
    drawGateway(gatewayPrompt(), { onSubmit });
    await panelIn(container);
    const other = container.querySelector<HTMLTextAreaElement>("textarea")!;
    other.value = "A draft that is not ready";
    other.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flush();
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
    drawGateway(gatewayPrompt(), { onSubmit });
    await panelIn(container);
    const other = container.querySelector<HTMLTextAreaElement>(".chat-question-panel__other")!;

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
    drawGateway(gatewayPrompt(), { onSkip });
    await panelIn(container);

    container.querySelector<HTMLButtonElement>(".chat-question-panel__collapse")?.click();
    flush();
    expect(container.querySelector(".chat-question-panel--collapsed")?.textContent).toContain(
      "Format",
    );
    expect(onSkip).not.toHaveBeenCalled();

    container.querySelector<HTMLButtonElement>(".chat-question-panel__collapsed-button")?.click();
    flush();
    expect(document.activeElement).toBe(container.querySelector(".chat-question-panel"));
    container.querySelector<HTMLButtonElement>(".chat-question-panel__skip")?.click();
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("manages collapse state when no controlled callback is supplied", async () => {
    await drawUncontrolled({});

    container.querySelector<HTMLButtonElement>(".chat-question-panel__collapse")?.click();
    flush();
    expect(container.querySelector(".chat-question-panel--collapsed")).not.toBeNull();

    container.querySelector<HTMLButtonElement>(".chat-question-panel__collapsed-button")?.click();
    flush();
    expect(container.querySelector(".chat-question-panel--collapsed")).toBeNull();
  });

  it("honors initial autofocus opt-out and focuses the panel when expanded", async () => {
    const props = createGatewayQuestionPanelProps(gatewayPrompt(), {});
    drawPanel({ ...props, model: { ...props.model, autoFocus: false } });
    await panelIn(container);
    expect(document.activeElement).toBe(document.body);

    container.querySelector<HTMLButtonElement>(".chat-question-panel__collapse")!.click();
    flush();
    container.querySelector<HTMLButtonElement>(".chat-question-panel__collapsed-button")!.click();
    flush();
    expect(document.activeElement).toBe(container.querySelector(".chat-question-panel"));
  });

  it("keeps a typed answer distinct from an identical option across remounts", async () => {
    const prompt = gatewayPrompt();
    const onSubmit = vi.fn();
    drawGateway(prompt, { onSubmit });
    await panelIn(container);
    const other = container.querySelector<HTMLTextAreaElement>(".chat-question-panel__other")!;
    other.value = "Compact";
    other.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flush();

    mounted?.unmount();
    mounted = undefined;
    drawGateway(prompt, { onSubmit });
    await panelIn(container);

    expect(container.querySelector<HTMLTextAreaElement>(".chat-question-panel__other")!.value).toBe(
      "Compact",
    );
    expect(container.querySelector('[aria-checked="true"]')).toBeNull();
    container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.click();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ format: ["Compact"] });
  });

  it("keeps a newer submission locked when an older visit to the same question settles", async () => {
    const older = createDeferred();
    const newer = createDeferred();
    const onSubmit = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const prompt = gatewayPrompt();
    drawGateway(prompt, { onSubmit });
    await panelIn(container);
    container.querySelector<HTMLButtonElement>('[role="radio"]')!.click();
    flush();
    container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.click();

    drawGateway(gatewayPrompt({ id: "another-question" }));
    flush();
    drawGateway(prompt, { onSubmit });
    flush();
    const button = container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!;
    button.click();
    flush();
    older.resolve();
    await older.promise;
    flush();
    expect(button.disabled).toBe(true);
    newer.resolve();
    await waitForSolid(() => expect(button.disabled).toBe(false));
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});
