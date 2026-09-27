import { describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { contextWith, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";

describe("new-session Fast Mode preferences", () => {
  it.each([
    { inherited: true, checked: "true", toggleValue: "off", next: false },
    { inherited: false, checked: "false", toggleValue: "on", next: true },
    { inherited: "auto", checked: "true", toggleValue: "off", next: false },
  ] as const)(
    "renders the current composer toggle for inherited Fast Mode $inherited",
    async ({ inherited, checked, toggleValue, next }) => {
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
        const toggle = container.querySelector<HTMLButtonElement>("[data-chat-speed-toggle]");
        expect(
          container.querySelector(".chat-controls__fast-mode-title")?.textContent?.trim(),
        ).toBe("Fast mode");
        expect(toggle?.classList.contains("chat-controls__speed-toggle")).toBe(true);
        expect(toggle?.dataset.chatSpeedToggle).toBe(toggleValue);
        expect(toggle?.getAttribute("aria-checked")).toBe(checked);
      });

      renderControl(control, context)
        .querySelector<HTMLButtonElement>("[data-chat-speed-toggle]")
        ?.click();
      expect(control.fastMode).toBe(next);
      expect(onSelectionChange).toHaveBeenLastCalledWith({
        model: "",
        thinkingLevel: "",
        fastMode: next,
      });
    },
  );

  it.each([true, false, "auto"] as const)(
    "restores a standalone Fast Mode preference %s",
    async (fastMode) => {
      const { context } = contextWith([
        { id: "gpt-5.6-luna", name: "Model", provider: "openai", reasoning: true },
      ]);
      const control = new NewSessionModelControl(() => undefined);
      control.load(context, "main", true, { preference: { fastMode } });
      expect(control.isRestoringPreference()).toBe(true);
      await waitForFast(() => expect(control.fastMode).toBe(fastMode));
      expect(
        renderControl(control, context)
          .querySelector("[data-chat-speed-toggle]")
          ?.getAttribute("aria-checked"),
      ).toBe(String(fastMode !== false));
      control.load(context, "other", true);
      expect(control.fastMode).toBeUndefined();
      control.reset();
    },
  );

  it("does not restore Fast Mode for an unsupported provider", async () => {
    const { context } = contextWith([{ id: "local-model", name: "Local", provider: "ollama" }]);
    const onSelectionChange = vi.fn();
    const control = new NewSessionModelControl(() => undefined, onSelectionChange);
    control.load(context, "main", true, {
      preference: { model: "ollama/local-model", fastMode: true },
    });
    await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
    expect(control.fastMode).toBeUndefined();
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      model: "ollama/local-model",
      thinkingLevel: "",
      fastMode: undefined,
    });
    control.reset();
  });

  it.each([
    { provider: "ollama", supportsFastMode: true },
    { provider: "openai", supportsFastMode: false },
  ])(
    "restores Fast Mode according to catalog support $supportsFastMode for $provider",
    async ({ provider, supportsFastMode }) => {
      const model = `${provider}/model`;
      const { context } = contextWith([{ id: "model", name: "Model", provider, supportsFastMode }]);
      const onSelectionChange = vi.fn();
      const control = new NewSessionModelControl(() => undefined, onSelectionChange);
      control.load(context, "main", true, { preference: { model, fastMode: true } });
      await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
      expect(control.fastMode).toBe(supportsFastMode ? true : undefined);
      if (supportsFastMode) {
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

  it.each([true, false])("uses alternate runtime Fast Mode support %s", async (support) => {
    const { context } = contextWith([
      {
        id: "model",
        name: "Model",
        provider: "openai",
        supportsFastMode: !support,
        agentRuntime: { id: "openclaw", source: "model" },
        runtimeChoices: [
          {
            agentRuntime: { id: "codex", source: "model" },
            supportsFastMode: support,
            available: true,
          },
        ],
      },
    ]);
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true, {
      preference: { model: "openai/model", agentRuntime: "codex", fastMode: true },
    });
    await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
    expect(control.agentRuntime).toBe("codex");
    expect(control.fastMode).toBe(support ? true : undefined);
    control.reset();
  });

  it("clears Fast Mode when switching to a provider without a wire mapping", async () => {
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
      .querySelector<HTMLButtonElement>("[data-chat-speed-toggle]")
      ?.click();
    expect(control.fastMode).toBe(true);

    renderControl(control, context)
      .querySelector<HTMLButtonElement>('[data-chat-model-option="ollama/llama-4"]')
      ?.click();

    expect(control.selected).toBe("ollama/llama-4");
    expect(control.fastMode).toBeUndefined();
    const unsupportedToggle = renderControl(control, context).querySelector<HTMLButtonElement>(
      "[data-chat-speed-toggle]",
    );
    expect(unsupportedToggle?.disabled).toBe(true);
    expect(unsupportedToggle?.getAttribute("aria-checked")).toBe("false");
    expect(unsupportedToggle?.dataset.chatSpeedToggle).toBe("");
  });
});
