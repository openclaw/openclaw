/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createGatewayQuestionPanelProps } from "./chat-question-card.ts";
import type { QuestionPanelProps } from "./chat-question-card.ts";
import { ChatQuestionPanel } from "./chat-question-panel.tsx";

function gatewayPrompt(
  overrides: Partial<QuestionPrompt> | QuestionPrompt["questions"] = {},
): QuestionPrompt {
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
    ...(Array.isArray(overrides) ? { questions: overrides } : overrides),
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
  let mounted: ReturnType<typeof mountSolid<{ props: QuestionPanelProps }>> | undefined;
  const find = <T extends Element = HTMLElement>(selector: string) =>
    container.querySelector<T>(selector);
  const part = <T extends Element = HTMLElement>(name: string) =>
    find<T>(`.chat-question-panel__${name}`);
  function expectPresent(...selectors: string[]) {
    for (const selector of selectors) {
      expect(find(selector)).not.toBeNull();
    }
  }
  const click = (selector: string) => {
    find<HTMLButtonElement>(selector)!.click();
    flush();
  };
  function press(
    key: string,
    options: KeyboardEventInit = {},
    target: Element = find(".chat-question-panel")!,
  ) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, ...options });
    target.dispatchEvent(event);
    return event;
  }
  const fill = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flush();
  };
  function drawPanel(props: QuestionPanelProps) {
    if (!mounted) {
      mounted = mountSolid(ChatQuestionPanel, { props }, container);
    } else {
      mounted.update({ props });
    }
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    mounted?.dispose();
    mounted = undefined;
    container.remove();
  });

  function drawGateway(
    prompt: QuestionPrompt,
    callbacks: Pick<QuestionPanelProps, "onSubmit" | "onSkip"> = {},
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

  async function showGateway(
    prompt: QuestionPrompt | QuestionPrompt["questions"] = gatewayPrompt(),
    callbacks: Parameters<typeof drawGateway>[1] = {},
  ) {
    const onSubmit = vi.fn();
    drawGateway(Array.isArray(prompt) ? gatewayPrompt(prompt) : prompt, { onSubmit, ...callbacks });
    await panelIn(container);
    return onSubmit;
  }

  function drawUncontrolled(options: Parameters<typeof createGatewayQuestionPanelProps>[1]) {
    drawPanel(createGatewayQuestionPanelProps(gatewayPrompt(), options));
    return panelIn(container);
  }

  it("steps from single-select to multi-select and preserves array answers", async () => {
    const prompt = gatewayPrompt([
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
    ]);
    const onSubmit = await showGateway(prompt);
    expectPresent(
      '[role="radio"] .chat-question-panel__option-marker',
      '[role="radio"] kbd',
      ".chat-question-panel__option--other .chat-question-panel__option-marker",
      ".chat-question-panel__option--other kbd",
      '[role="radiogroup"]',
    );
    expect(
      find<HTMLTextAreaElement>(".chat-question-panel__option--other textarea")?.placeholder,
    ).toBe("Type your own answer here");
    expect(part("progress")?.textContent).toBe("1/2");
    click('[role="radio"]');
    expect(part("prompt")?.textContent).toBe("Which extras should I include?");
    expect(part("progress")?.textContent).toBe("2/2");
    expect(document.activeElement).toBe(find(".chat-question-panel"));
    click(".chat-question-panel__back");
    expect(part("prompt")?.textContent).toBe("Where should I send it?");
    click('[role="radio"]');
    container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[0]?.click();
    container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[1]?.click();
    const other = part<HTMLTextAreaElement>("other")!;
    fill(other, "Metrics");
    part<HTMLButtonElement>("advance")?.click();
    expect(onSubmit).toHaveBeenCalledWith({
      target: ["Chat"],
      extras: ["Tests", "Docs", "Metrics"],
    });
  });

  it("renders thumbnail fallbacks and submits suggested plus multiple custom array entries", async () => {
    const prompt = gatewayPrompt([
      freeTextQuestion({
        questionId: "parts",
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
      }),
    ]);
    const onSubmit = await showGateway(prompt);
    expect(container.querySelectorAll(".chat-question-panel__thumbnail")).toHaveLength(2);
    const image = find<HTMLImageElement>(".chat-question-panel__thumbnail img");
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(find('[aria-checked="true"]')?.textContent).toContain("Washer");
    const input = part<HTMLTextAreaElement>("other")!;
    fill(input, "custom-spacer\ncustom-gasket");
    part<HTMLButtonElement>("advance")?.click();
    expect(onSubmit).toHaveBeenCalledWith({ parts: ["washer", "custom-spacer", "custom-gasket"] });
  });

  it("does not automatically load remote form thumbnails", async () => {
    await showGateway([
      freeTextQuestion({
        presentation: "form",
        options: [{ label: "Washer", thumbnail: "https://example.com/washer.png" }],
      }),
    ]);
    expect(find("img")).toBeNull();
    const link = part<HTMLAnchorElement>("external-image");
    expect(link?.href).toBe("https://example.com/washer.png");
    expect(link?.rel).toBe("noreferrer noopener");
  });

  it("removes implicit resource selections and never substitutes a free-text URI input", async () => {
    const onSubmit = vi.fn();
    await showGateway(
      [
        freeTextQuestion({
          questionId: "parts",
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
        }),
      ],
      { onSubmit },
    );
    expect(find("textarea")).toBeNull();
    expect(find('input[type="file"]')).not.toBeNull();
    click('[aria-label="Remove Washer"]');
    expect(find('[data-option-index="0"]')).toBeNull();
    part<HTMLButtonElement>("advance")?.click();
    expect(onSubmit).toHaveBeenCalledWith({ parts: [] });
  });

  it("keeps a store-bound secret masked while preserving editable destination hosts", async () => {
    const prompt = gatewayPrompt({
      agentId: "release-agent",
      questions: [
        freeTextQuestion({
          questionId: "api_key",
          header: "API key",
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
        }),
      ],
    });
    const onSubmit = await showGateway(prompt);
    const hosts = part<HTMLInputElement>("hosts")!;
    const secret = find<HTMLInputElement>('input[type="password"]')!;
    expect(hosts.value).toBe("api.example.test");
    expect(secret).toMatchObject({ autocomplete: "off", placeholder: "FAKE_DEPLOYMENT_API_KEY" });
    expect(secret.labels?.[0]?.textContent).toContain("API key");
    expect(part("options")).toBeNull();
    expect(part("option-marker")).toBeNull();
    expect(find("kbd")).toBeNull();
    expect(container.textContent).toContain("release-agent");
    expect(container.textContent).toContain("agent:main:main");
    expect(container.textContent).toContain("Stores FAKE_DEPLOYMENT_API_KEY as Protected secret");
    expect(container.textContent).toContain("Deploy the approved release");
    expect(container.textContent).toContain("Replaces FAKE_DEPLOYMENT_API_KEY — last updated");
    expect(container.textContent).toContain("by release-owner");
    fill(hosts, "api.example.test, uploads.example.test");
    expect(prompt.secretStoreAllowedHostsDraft).toBe("api.example.test, uploads.example.test");
    const fakeSecret = "  fake-secret-value-for-ui-test  ";
    fill(secret, fakeSecret);
    expect(prompt.drafts.get("api_key")?.freeText).toBe(fakeSecret);
    expect(secret.value).toBe(fakeSecret);
    expect(container.textContent).not.toContain(fakeSecret);
    expect(container.innerHTML).not.toContain(fakeSecret);
    const expectSecret = (type: string) => {
      expect(secret).toMatchObject({ type, value: fakeSecret });
      expect(container.textContent).not.toContain(fakeSecret);
      expect(container.innerHTML).not.toContain(fakeSecret);
    };
    const toggle = find<HTMLButtonElement>('button[aria-label="Show secret"]')!;
    expect(toggle).not.toBeNull();
    toggle.click();
    flush();
    expectSecret("text");
    expect(toggle.getAttribute("aria-label")).toBe("Hide secret");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    toggle.click();
    flush();
    expectSecret("password");

    part<HTMLButtonElement>("advance")?.click();
    expect(onSubmit).toHaveBeenCalledWith({ api_key: [fakeSecret] });
  });

  it("remasks secrets when moving to another question or request", async () => {
    const prompt = gatewayPrompt([
      freeTextQuestion({ questionId: "first", isSecret: true }),
      freeTextQuestion({ questionId: "second", isSecret: true }),
    ]);
    await showGateway(prompt);
    const input = () => find<HTMLInputElement>("input")!;
    const reveal = () => {
      find<HTMLButtonElement>('button[aria-label="Show secret"]')!.click();
      flush();
    };
    fill(input(), "fake-secret-first");
    reveal();
    expect(input().type).toBe("text");
    click(".chat-question-panel__advance");
    expect(input()).toMatchObject({ type: "password", value: "" });
    click(".chat-question-panel__back");
    expect(input()).toMatchObject({ type: "password", value: "fake-secret-first" });
    reveal();
    await showGateway(gatewayPrompt({ id: "question-2", questions: prompt.questions }));
    expect(input()).toMatchObject({ type: "password", value: "" });
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
    await showGateway([freeTextQuestion({ header: "" })]);
    const input = find<HTMLInputElement | HTMLTextAreaElement>("input, textarea")!;
    expect(input.labels?.[0]?.textContent).toContain("Answer");
    expect(input.placeholder).toBe("Answer");
  });

  it("keeps environment store requests masked without exposing a destination-host editor", async () => {
    await showGateway([
      freeTextQuestion({
        isSecret: true,
        secretStore: { name: "FAKE_ENVIRONMENT_VALUE", kind: "env" },
      }),
    ]);
    expect(find('input[type="password"]')).not.toBeNull();
    expect(part("hosts")).toBeNull();
    expect(container.textContent).toContain(
      "Stores FAKE_ENVIRONMENT_VALUE as Agent-readable environment",
    );
  });

  it("supports numeric selection and Enter submission while focused", async () => {
    const onSubmit = await showGateway();

    press("2");
    flush();
    expect(
      container.querySelectorAll<HTMLElement>('[role="radio"]')[1]?.getAttribute("aria-checked"),
    ).toBe("true");

    press("Enter");
    expect(onSubmit).toHaveBeenCalledWith({ format: ["Detailed"] });
  });

  it("leaves modified numeric shortcuts to the browser", async () => {
    const onSubmit = await showGateway();

    press("2", { ctrlKey: true });
    flush();
    expect(find('[aria-checked="true"]')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not expose an Other shortcut for optionless free text", async () => {
    await showGateway([freeTextQuestion({ isOther: true })]);
    const event = press("1", { cancelable: true });
    expect(event.defaultPrevented).toBe(false);
  });

  it("uses roving radio focus and arrow-key selection", async () => {
    await showGateway([
      ...gatewayPrompt().questions,
      freeTextQuestion({ options: [{ label: "Ready" }], isOther: false }),
    ]);
    const radios = container.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect([...radios].map((radio) => radio.tabIndex)).toEqual([0, -1]);
    radios[0]?.focus();
    press("ArrowRight", {}, radios[0]!);
    flush();
    const updated = container.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect([...updated].map((radio) => radio.tabIndex)).toEqual([-1, 0]);
    expect(updated[1]?.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(updated[1]);
    expect(part("prompt")?.textContent).toBe("Which format should I use?");
  });

  it("leaves IME Ctrl+Enter editing to the textarea", async () => {
    const onSubmit = await showGateway();
    const other = find<HTMLTextAreaElement>("textarea")!;
    fill(other, "A draft that is not ready");
    const event = press("Enter", { ctrlKey: true, isComposing: true, cancelable: true }, other);
    expect(event.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[aria-checked="true"]')).toHaveLength(0);
  });

  it("uses Ctrl+Enter in Other to submit a multiline answer", async () => {
    const onSubmit = await showGateway();
    const other = part<HTMLTextAreaElement>("other")!;

    other.value = "Markdown table\nInclude the tradeoffs.";
    other.dispatchEvent(new InputEvent("input", { bubbles: true }));
    press("Enter", { ctrlKey: true }, other);
    flush();
    expect(onSubmit).toHaveBeenCalledWith({ format: ["Markdown table\nInclude the tradeoffs."] });
  });

  it("collapses without answering and exposes gateway cancellation through Skip", async () => {
    const onSkip = vi.fn();
    await showGateway(undefined, { onSkip });
    click(".chat-question-panel__collapse");
    expect(find(".chat-question-panel--collapsed")?.textContent).toContain("Format");
    expect(onSkip).not.toHaveBeenCalled();
    click(".chat-question-panel__collapsed-button");
    expect(document.activeElement).toBe(find(".chat-question-panel"));
    part<HTMLButtonElement>("skip")?.click();
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("manages collapse state when no controlled callback is supplied", async () => {
    await drawUncontrolled({});
    click(".chat-question-panel__collapse");
    expect(find(".chat-question-panel--collapsed")).not.toBeNull();
    click(".chat-question-panel__collapsed-button");
    expect(find(".chat-question-panel--collapsed")).toBeNull();
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
    await showGateway(prompt, { onSubmit });
    click('[role="radio"]');
    part<HTMLButtonElement>("advance")!.click();

    drawGateway(gatewayPrompt({ id: "another-question" }));
    flush();
    drawGateway(prompt, { onSubmit });
    flush();
    const button = part<HTMLButtonElement>("advance")!;
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
