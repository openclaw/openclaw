import { describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { contextWith, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";

describe("new-session speed preferences", () => {
  it.each([
    { inherited: true, selected: "on", nextOption: "off", next: false },
    { inherited: false, selected: "off", nextOption: "on", next: true },
    { inherited: "auto", selected: undefined, nextOption: "off", next: false },
  ] as const)(
    "renders explicit choices for inherited speed $inherited",
    async ({ inherited, selected, nextOption, next }) => {
      const { context } = contextWith([
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          reasoning: true,
          effectiveFastMode: inherited,
        },
      ]);
      const onSelectionChange = vi.fn();
      const control = new NewSessionModelControl(() => undefined, onSelectionChange);
      control.load(context, "main", true);

      await vi.waitFor(() => {
        const container = renderControl(control, context);
        expect(
          container
            .querySelector(".chat-controls__speed-panel .chat-controls__effort-heading")
            ?.textContent?.trim(),
        ).toBe("Speed");
        const options = Array.from(
          container.querySelectorAll<HTMLButtonElement>("[data-chat-speed-option]"),
        );
        expect(options.map((option) => option.textContent?.trim())).toEqual(["Standard", "Fast"]);
        for (const option of options) {
          expect(option.getAttribute("role")).toBe("radio");
          expect(option.getAttribute("aria-checked")).toBe(
            String(option.dataset.chatSpeedOption === selected),
          );
        }
      });

      renderControl(control, context)
        .querySelector<HTMLButtonElement>(`[data-chat-speed-option="${nextOption}"]`)
        ?.click();
      expect(control.fastMode).toBe(next);
      expect(onSelectionChange).toHaveBeenLastCalledWith({
        model: "",
        thinkingLevel: "",
        fastMode: next,
      });
    },
  );

  it.each(["auto", "ultrafast"] as const)(
    "restores a standalone speed preference %s",
    async (fastMode) => {
      const { context } = contextWith([
        {
          id: "gpt-5.6-luna",
          name: "Model",
          provider: "openai",
          reasoning: true,
          available: true,
          serviceTiers: ["ultrafast"],
        },
      ]);
      const control = new NewSessionModelControl(() => undefined);
      control.load(context, "main", true, { preference: { fastMode } });
      expect(control.isRestoringPreference()).toBe(true);
      await waitForFast(() => expect(control.fastMode).toBe(fastMode));
      const selected = fastMode === "auto" ? undefined : "ultrafast";
      const options = Array.from(
        renderControl(control, context).querySelectorAll<HTMLButtonElement>(
          "[data-chat-speed-option]",
        ),
      );
      expect(options).toHaveLength(3);
      for (const option of options) {
        expect(option.getAttribute("aria-checked")).toBe(
          String(option.dataset.chatSpeedOption === selected),
        );
      }
      control.load(context, "other", true);
      expect(control.fastMode).toBeUndefined();
      control.reset();
    },
  );

  it.each([
    { provider: "ollama", support: true, runtime: undefined },
    { provider: "openai", support: false, runtime: undefined },
    { provider: "openai", support: true, runtime: "codex" },
    { provider: "openai", support: false, runtime: "codex" },
  ])(
    "restores speed for $provider/$runtime with support=$support",
    async ({ provider, support, runtime }) => {
      const model = `${provider}/model`;
      const { context } = contextWith([
        {
          id: "model",
          name: "Model",
          provider,
          supportsFastMode: runtime ? !support : support,
          ...(runtime
            ? {
                agentRuntime: { id: "openclaw", source: "model" },
                runtimeChoices: [
                  {
                    agentRuntime: { id: runtime, source: "model" },
                    supportsFastMode: support,
                    available: true,
                  },
                ],
              }
            : {}),
        },
      ]);
      const onSelectionChange = vi.fn();
      const control = new NewSessionModelControl(
        () => undefined,
        runtime ? undefined : onSelectionChange,
      );
      control.load(context, "main", true, {
        preference: { model, agentRuntime: runtime, fastMode: true },
      });
      await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
      expect(control.fastMode).toBe(support ? true : undefined);
      if (runtime) {
        expect(control.agentRuntime).toBe(runtime);
      } else if (support) {
        expect(onSelectionChange).not.toHaveBeenCalled();
      } else {
        expect(onSelectionChange).toHaveBeenLastCalledWith({
          model,
          thinkingLevel: "",
          fastMode: undefined,
        });
      }
      control.reset();
    },
  );

  it("clears speed when switching to a provider without a wire mapping", async () => {
    const { context } = contextWith([
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai", reasoning: true },
      {
        id: "llama-4",
        name: "Llama 4",
        provider: "ollama",
        thinkingLevels: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ]);
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true);

    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelector('[data-chat-model-option="ollama/llama-4"]'),
      ).not.toBeNull(),
    );
    renderControl(control, context)
      .querySelector<HTMLButtonElement>('[data-chat-speed-option="on"]')
      ?.click();
    expect(control.fastMode).toBe(true);

    renderControl(control, context)
      .querySelector<HTMLButtonElement>('[data-chat-model-option="ollama/llama-4"]')
      ?.click();

    expect(control.selected).toBe("ollama/llama-4");
    expect(control.fastMode).toBeUndefined();
    expect(renderControl(control, context).querySelector("[data-chat-speed-option]")).toBeNull();
  });
});

it.each(["blue", "red"])(
  "applies supported speed choices when switching a Fast draft to Daybreak %s",
  async (color) => {
    const id = "gpt-daybreak-" + color + "-latest";
    const { context } = contextWith([
      {
        id: "gpt-5.6-luna",
        name: "General model",
        provider: "openai",
        reasoning: true,
        supportsFastMode: true,
      },
      {
        id,
        name: "Daybreak",
        provider: "openai",
        reasoning: true,
        supportsFastMode: color === "blue",
        supportsServiceTierRecovery: true,
        serviceTiers: color === "blue" ? ["default", "priority"] : ["default"],
        effectiveFastMode: "ultrafast",
      },
    ]);
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true);
    await waitForFast(() =>
      expect(
        renderControl(control, context).querySelector('[data-chat-speed-option="on"]'),
      ).not.toBeNull(),
    );
    renderControl(control, context)
      .querySelector<HTMLButtonElement>('[data-chat-speed-option="on"]')!
      .click();
    expect(control.fastMode).toBe(true);
    renderControl(control, context)
      .querySelector<HTMLButtonElement>('[data-chat-model-option="openai/' + id + '"]')!
      .click();
    const container = renderControl(control, context);
    expect(control.selected).toBe("openai/" + id);
    expect(
      container
        .querySelector('[data-chat-speed-option="' + (color === "blue" ? "on" : "off") + '"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    for (const option of container.querySelectorAll<HTMLButtonElement>(
      "[data-chat-speed-option]",
    )) {
      expect(option.disabled).toBe(
        color === "red" || option.dataset.chatSpeedOption === "ultrafast",
      );
    }
    expect(
      container.querySelector<HTMLInputElement>("[data-chat-thinking-slider]")?.disabled,
    ).not.toBe(true);
    control.reset();
  },
);
