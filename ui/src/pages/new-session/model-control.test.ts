import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayAgentRow, ModelCatalogEntry } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { buildDraftSessionCreateParams } from "./create-params.ts";
import { contextWith, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";
import { loadNewSessionPreference, replaceBrowserPreference } from "./preferences.ts";

const luna = { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" };
const sol = { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", reasoning: true };
const levels = (ids: string[]) => ids.map((id) => ({ id, label: id }));
const controls: NewSessionModelControl[] = [];
function setup(models: ModelCatalogEntry[], methods: string[] = []) {
  const state = contextWith(models, "openclaw", methods);
  const changed = vi.fn();
  const targetSelected = vi.fn();
  const control = new NewSessionModelControl(() => undefined, changed, targetSelected);
  controls.push(control);
  const draw = (agent?: GatewayAgentRow | null) =>
    renderControl(control, state.context, "main", agent);
  const find = (selector: string) => draw().querySelector<HTMLButtonElement>(selector);
  return { ...state, control, changed, targetSelected, draw, find };
}
afterEach(() => {
  for (const control of controls.splice(0)) {
    control.reset();
  }
  vi.restoreAllMocks();
});

describe("new-session model controls", () => {
  it("does not borrow a provider for an ambiguous draft target", async () => {
    const { control, context, draw, changed } = setup([
      {
        id: "model",
        name: "First model",
        provider: "openai",
        reasoning: true,
        thinkingLevels: levels(["high"]),
        thinkingDefault: "high",
      },
      { id: "model", name: "Second model", provider: "alternate-fixture", reasoning: true },
    ]);
    Object.assign(context.sessions.state.result!.defaults, {
      model: "other",
      modelProvider: "openai",
    });
    const agent = { id: "main", model: { primary: "model" } };
    control.load(context, "main", true, { agent });
    await vi.waitFor(() =>
      expect(draw(agent).querySelector('[data-chat-model-option="openai/model"]')).not.toBeNull(),
    );
    expect(draw(agent).querySelector('[data-chat-thinking-option="high"]')).toBeNull();
    expect(draw(agent).querySelector("[data-chat-thinking-slider]")).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });

  it("waits for selected-agent defaults after catalog hydration", async () => {
    const { control, context, find, draw } = setup([{ ...luna, reasoning: true }, sol]);
    control.load(context, "main", true);
    await vi.waitFor(() =>
      expect(find('[data-chat-model-option="openai/gpt-5.6-luna"]')).not.toBeNull(),
    );
    const loading = draw(null);
    const trigger = loading.querySelector("[data-chat-model-select]")!;
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(trigger.getAttribute("aria-label")).toBe("Chat model: Loading models…");
    expect(trigger.querySelector(".skeleton")?.getAttribute("aria-hidden")).toBe("true");
    expect(trigger.textContent).not.toMatch(/Loading models|Default model/);
    expect(
      loading.querySelector<HTMLElement>("[data-chat-thinking-select]")?.dataset
        .chatThinkingDisabled,
    ).toBe("true");
    const ready = draw({
      id: "main",
      model: { primary: "openai/gpt-5.6-sol" },
      thinkingLevels: [
        { id: "off", label: "Off" },
        { id: "high", label: "High" },
      ],
      thinkingDefault: "high",
    });
    expect(ready.querySelector('[data-chat-model-default="true"]')?.textContent).toContain(
      "GPT-5.6 Sol",
    );
    expect(ready.querySelector("[data-chat-model-select]")?.textContent).toContain("GPT-5.6 Sol");
    expect(ready.querySelector("[data-chat-thinking-select]")?.textContent).toContain("High");
    expect(
      ready.querySelector("[data-chat-thinking-slider]")?.getAttribute("data-chat-thinking-values"),
    ).toContain("high");
    expect(control.selected).toBe("");
    expect(control.thinkingLevel).toBe("");
  });

  it("preserves an explicitly remembered Off effort", async () => {
    const { control, context, draw } = setup([sol]);
    const agent = {
      id: "main",
      model: { primary: "openai/gpt-5.6-sol" },
      thinkingLevels: [
        { id: "off", label: "Off" },
        { id: "high", label: "High" },
      ],
      thinkingDefault: "high",
    };
    control.load(context, "main", true, { agent, preference: { thinkingLevel: "off" } });
    await vi.waitFor(() => expect(control.thinkingLevel).toBe("off"));
    expect(draw(agent).querySelector("[data-chat-thinking-select]")?.textContent).toContain("Off");
    expect(control.selected).toBe("");
  });

  it("renders an all-cold catalog as setup actions", async () => {
    const { control, context, draw, navigate } = setup(
      [luna, sol].map((model) =>
        Object.assign({}, model, {
          available: false,
          unavailableReason: "missing-auth",
        } satisfies Pick<ModelCatalogEntry, "available" | "unavailableReason">),
      ),
    );
    control.load(context, "main", true);
    await vi.waitFor(() =>
      expect(draw().querySelector('[data-chat-model-catalog-state="ready"]')).not.toBeNull(),
    );
    const container = draw();
    expect(container.querySelector("[data-chat-model-select]")?.textContent).toContain(luna.name);
    expect(
      control.modelUnavailableReason({ id: "main", model: { primary: "openai/gpt-5.6-luna" } }),
    ).toBe("missing-auth");
    const options = [...container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]")];
    expect(options).toHaveLength(2);
    expect(options[0]?.textContent).toContain("Sign-in needed");
    expect(
      options.every((option) => !option.disabled && option.dataset.chatModelSetup === "true"),
    ).toBe(true);
    expect(container.textContent).toContain("No models available");
    container.querySelector<HTMLButtonElement>('[data-chat-model-setup="true"]')!.click();
    expect(navigate).toHaveBeenCalledWith("model-setup");
  });

  it("does not restore a stale preference when picker-open recovery succeeds", async () => {
    const { control, context, request, find, draw } = setup([luna, sol]);
    const refresh = deferred<{ models: ModelCatalogEntry[] }>();
    const options = {
      agent: { id: "main", model: { primary: "openai/gpt-5.6-luna" } },
      preference: { model: "openai/gpt-5.6-luna" },
    };
    control.load(context, "main", true, options);
    await vi.waitFor(() =>
      expect(draw().querySelectorAll("[data-chat-model-option]")).toHaveLength(2),
    );
    request.mockReturnValueOnce(refresh.promise);
    control.invalidate(false);
    control.load(context, "main", true, options);
    expect(find("[data-chat-model-catalog-state]")).toBeNull();
    expect(find('[data-chat-model-option="openai/gpt-5.6-sol"]')?.disabled).toBe(false);
    find('[data-chat-model-option="openai/gpt-5.6-sol"]')!.click();
    expect(control.selected).toBe("openai/gpt-5.6-sol");
    refresh.reject(new Error("refresh failed"));
    await vi.waitFor(() => expect(find('[data-chat-model-catalog-state="error"]')).not.toBeNull());
    expect(draw().querySelectorAll("[data-chat-model-option]")).toHaveLength(2);
    expect(find("[data-chat-model-select]")?.textContent).toContain(sol.name);
    const picker = draw().querySelector<HTMLDetailsElement>(".chat-controls__model-picker")!;
    picker.open = true;
    picker.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(find("[data-chat-model-catalog-state]")).toBeNull());
    expect(draw().querySelectorAll("[data-chat-model-option]")).toHaveLength(2);
    expect(control.selected).toBe("openai/gpt-5.6-sol");
  });

  it("drops a stored model and reasoning when manual selection is denied", async () => {
    const { control, context, request, changed } = setup([
      sol,
      {
        id: "retired-model",
        name: "Retired model",
        provider: "anthropic",
        manualSelectionAllowed: false,
      },
    ]);
    control.load(context, "main", true, {
      preference: { model: "openai/gpt-5.6-sol", thinkingLevel: "high" },
    });
    await vi.waitFor(() => expect(control.selected).toBe("openai/gpt-5.6-sol"));
    expect(control.thinkingLevel).toBe("high");
    control.load(context, "main", true, {
      preference: { model: "anthropic/retired-model", thinkingLevel: "high" },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(control.selected).toBe("");
    expect(control.thinkingLevel).toBe("");
    expect(changed).toHaveBeenLastCalledWith({ model: "", thinkingLevel: "" });
  });

  it("clears xhigh when an interactive model switch targets a profile ending at high", async () => {
    const { control, context, find, changed } = setup([
      {
        id: "k3",
        name: "Kimi K3",
        provider: "kimi",
        reasoning: true,
        thinkingLevels: levels(["off", "low", "medium", "high", "xhigh"]),
        thinkingDefault: "high",
      },
      {
        id: "limited",
        name: "Limited",
        provider: "demo",
        reasoning: true,
        thinkingLevels: levels(["off", "low", "medium", "high"]),
        thinkingDefault: "medium",
      },
    ]);
    control.load(context, "main", true);
    await vi.waitFor(() => expect(find('[data-chat-model-option="demo/limited"]')).not.toBeNull());
    control.selected = "kimi/k3";
    control.thinkingLevel = "xhigh";
    find('[data-chat-model-option="demo/limited"]')!.click();
    expect(control.selected).toBe("demo/limited");
    expect(control.thinkingLevel).toBe("");
    expect(changed).toHaveBeenLastCalledWith({ model: "demo/limited", thinkingLevel: "" });
  });
});

const catalog = (id: string, startTerminal = true) => ({
  id,
  label: id,
  capabilities: { startTerminal },
  hosts: [],
});
describe("CLI-agent discovery", () => {
  it("retries failed discovery from the error action without refreshing models", async () => {
    const { control, context, request, find, targetSelected } = setup(
      [luna],
      ["sessions.catalog.list"],
    );
    const catalogs = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue({
        catalogs: [catalog("anthropic"), catalog("history-only", false)],
      });
    request.mockImplementation((method: string) =>
      method === "sessions.catalog.list" ? catalogs() : Promise.resolve({ models: [luna] }),
    );
    control.load(context, "main", true);
    control.loadCatalogTargets(context, "main", true);
    await vi.waitFor(() =>
      expect(find('[data-chat-model-target-retry="cliAgents"]')).not.toBeNull(),
    );
    control.loadCatalogTargets(context, "main", true);
    expect(catalogs).toHaveBeenCalledOnce();
    find('[data-chat-model-target-retry="cliAgents"]')!.click();
    await vi.waitFor(() =>
      expect(
        find('[data-chat-model-target-group="cliAgents"] [data-chat-model-catalog-state="error"]'),
      ).toBeNull(),
    );
    expect(catalogs).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(1);
    expect(request.mock.calls.some(([, params]) => params?.refresh)).toBe(false);
    expect(find('[data-chat-model-target="history-only"]')).toBeNull();
    find('[data-chat-model-target="anthropic"]')!.click();
    expect(targetSelected).toHaveBeenCalledExactlyOnceWith("anthropic");
    control.loadCatalogTargets(context, "main", true);
    expect(catalogs).toHaveBeenCalledTimes(2);
  });

  it("ignores a late catalog response after the same client switches agents", async () => {
    const main = deferred<{ catalogs: ReturnType<typeof catalog>[] }>();
    const { control, context, request, find } = setup([luna], ["sessions.catalog.list"]);
    request.mockImplementation((_method: string, params: { agentId: string }) =>
      params.agentId === "main"
        ? main.promise
        : Promise.resolve({ catalogs: [catalog("research")] }),
    );
    control.loadCatalogTargets(context, "main", true);
    control.loadCatalogTargets(context, "research", true);
    await vi.waitFor(() => expect(find('[data-chat-model-target="research"]')).not.toBeNull());
    main.resolve({ catalogs: [catalog("stale")] });
    await main.promise;
    expect(find('[data-chat-model-target="research"]')).not.toBeNull();
    expect(find('[data-chat-model-target="stale"]')).toBeNull();
  });
});

describe("runtime placement", () => {
  it.each([
    {
      supported: true,
      executionModes: ["worker-turn", "remote-exec"] as const,
      expected: undefined,
    },
    {
      supported: false,
      executionModes: undefined,
      expected: "The codex runtime does not support cloud workers.",
    },
  ])("checks cloud execution modes: $expected", ({ supported, executionModes, expected }) => {
    const { control } = setup([]);
    vi.spyOn(control, "resolveAgentRuntime").mockReturnValue({
      id: "codex",
      source: "model",
      cloudPlacementSupported: supported,
      cloudPlacementExecutionMode: "remote-exec",
    });
    expect(
      control.cloudRuntimeUnsupportedReason({ id: "aws", providerId: "crabbox", executionModes }),
    ).toBe(expected);
  });
  it.each([true, false])(
    "requires device-placement metadata despite a support flag: %s",
    (supported) => {
      const { control } = setup([]);
      vi.spyOn(control, "resolveAgentRuntime").mockReturnValue({
        id: "codex",
        source: "model",
        cloudPlacementSupported: true,
        devicePlacementSupported: true,
        ...(supported
          ? {
              devicePlacement: {
                requiredNodeCommands: ["codex.exec-server.stdio.v1"],
                consumesWorkerSlot: false,
              },
            }
          : {}),
      });
      expect(control.devicePlacementUnsupportedReason()).toBe(
        supported ? undefined : "This runtime does not support paired devices",
      );
    },
  );
});

describe("configured defaults", () => {
  const models = ["default-model", "other-model"].map((id) => ({
    id,
    name: id,
    provider: "openai",
    reasoning: true,
    supportsFastMode: true,
  }));
  const agent = { id: "main", model: { primary: "openai/default-model" }, thinkingDefault: "high" };
  const preference = { model: "openai/other-model", thinkingLevel: "low", fastMode: true };
  function setupDefaults() {
    const state = contextWith(models);
    Object.assign(state.context, {
      config: { current: { newSessionModelDefaults: "configured" } },
    });
    return state;
  }

  describe("configured fresh-session model defaults", () => {
    it("preserves URL intent until the next agent", async () => {
      const { context } = setupDefaults();
      const control = new NewSessionModelControl(() => undefined);
      control.load(context, "main", true, { agent, preference, initialModel: preference.model });
      await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
      expect(control.selected).toBe(preference.model);
      expect(control.modelForSubmission()).toBe(preference.model);
      control.load(context, "main", true, { agent, preference });
      await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
      expect(control.selected).toBe(preference.model);
      control.load(context, "other", true, { agent: { ...agent, id: "other" }, preference });
      await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
      expect(control.selected).toBe("");
      control.reset();
    });

    it("withholds stale preferences after metadata failure", async () => {
      const { context, request } = setupDefaults();
      request.mockRejectedValue(new Error("offline"));
      const control = new NewSessionModelControl(() => undefined);
      control.load(context, "main", true, {
        agent,
        preference: { ...preference, agentRuntime: "stale-runtime" },
      });
      await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
      expect(control).toMatchObject({ selected: "", agentRuntime: undefined, thinkingLevel: "" });
      control.reset();
    });

    it.each(["optional", "required", "required-after-hydration"])(
      "restores a deliberate same-route draft choice after %s hydration",
      async (placement) => {
        const { context } = setupDefaults();
        const control = new NewSessionModelControl(() => undefined);
        control.restoreDraftSelection({
          agentId: "main",
          model: "openai/other-model",
          thinkingLevel: "low",
        });
        control.load(context, "main", true, {
          agent,
          preference,
          initialModel: "openai/default-model",
          configuredDefaults: placement === "required",
        });
        await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
        expect(control.selected).toBe("openai/other-model");
        expect(control.thinkingLevel).toBe("low");
        expect(control.draftSelection("main")).toMatchObject({
          model: "openai/other-model",
          thinkingLevel: "low",
        });
        control.load(context, "main", true, {
          agent,
          preference,
          configuredDefaults: placement !== "optional",
        });
        expect(control.selected).toBe("openai/other-model");
        expect(control.thinkingLevel).toBe("low");
        control.reset();
      },
    );

    it("hydrates late Fast Mode preferences independently of a restored model", async () => {
      const { context, request } = setupDefaults();
      const catalogRead = deferred<{ models: typeof models }>();
      request.mockReturnValue(catalogRead.promise);
      const control = new NewSessionModelControl(() => undefined);
      control.load(context, "main", true, { agent, preference: null });
      control.restoreDraftSelection({
        agentId: "main",
        model: "openai/other-model",
        thinkingLevel: "low",
      });
      control.load(context, "main", true, { agent, preference });
      catalogRead.resolve({ models });
      await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
      expect(control.fastMode).toBe(true);
      renderControl(control, context, "main", agent)
        .querySelector<HTMLButtonElement>('[data-chat-speed-option="off"]')!
        .click();
      expect(control.fastMode).toBe(false);
      control.load(context, "main", true, { agent, preference });
      expect(control.fastMode).toBe(false);
      control.reset();
    });

    it("retires a consumed restored choice but preserves a newer deliberate choice", async () => {
      const { context } = setupDefaults();
      const control = new NewSessionModelControl(() => undefined);
      control.load(context, "main", true, { agent, preference });
      await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
      const saved = { agentId: "main", model: preference.model, thinkingLevel: "low" };
      control.restoreDraftSelection(saved);
      expect(control.selected).toBe(saved.model);
      control.restoreDraftSelection(undefined);
      expect(control).toMatchObject({
        selected: "",
        thinkingLevel: "",
        agentRuntime: undefined,
        fastMode: true,
      });
      expect(control.draftSelection("main")).toBeUndefined();
      control.restoreDraftSelection(saved);
      renderControl(control, context, "main", agent)
        .querySelector<HTMLButtonElement>('[data-chat-model-option="openai/default-model"]')!
        .click();
      control.restoreDraftSelection(undefined);
      expect(control.draftSelection("main")).toMatchObject({ model: "", thinkingLevel: "low" });
      control.reset();
    });
  });
});
describe("new-session speed preferences", () => {
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
    await waitForFast(() => {
      const container = renderControl(control, context);
      expect(
        container.querySelector('[data-chat-model-option="openai/' + id + '"]'),
      ).not.toBeNull();
      expect(container.querySelector('[data-chat-speed-option="on"]')).not.toBeNull();
    });
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

describe("runtime choices", () => {
  const agent: GatewayAgentRow = { id: "main", model: { primary: "openai/gpt-5.6-sol" } };
  const models: ModelCatalogEntry[] = [
    {
      id: "gpt-5.6-sol",
      provider: "openai",
      name: "GPT-5.6 Sol",
      available: true,
      contextWindow: 1_000_000,
      agentRuntime: {
        id: "openclaw",
        source: "model",
        cloudPlacementSupported: true,
        cloudPlacementExecutionMode: "worker-turn",
      },
      thinkingLevels: [{ id: "medium", label: "Medium" }],
      thinkingDefault: "medium",
      supportsTools: true,
      runtimeChoices: [
        {
          agentRuntime: {
            id: "codex",
            source: "model",
            cloudPlacementSupported: true,
            cloudPlacementExecutionMode: "remote-exec",
          },
          available: true,
          contextWindow: 200_000,
          contextWindows: [
            { id: "64k", label: "64K", contextWindow: 64_000 },
            { id: "200k", label: "200K", contextWindow: 200_000 },
          ],
          contextWindowDefault: "200k",
          thinkingLevels: [{ id: "high", label: "High" }],
          thinkingDefault: "high",
        },
      ],
    },
  ];

  describe("new-session runtime choice", () => {
    it("keeps the same-name runtime choice through preferences and create while using its own capabilities", async () => {
      const { context } = contextWith(models);
      const gatewayUrl = "ws://runtime-choice.example";
      const changed = vi.fn((selection) =>
        replaceBrowserPreference(gatewayUrl, "main", {
          ...loadNewSessionPreference(gatewayUrl, "main"),
          ...selection,
        }),
      );
      const control = new NewSessionModelControl(() => undefined, changed);
      control.load(context, "main", true, { agent });
      try {
        await vi.waitFor(() =>
          expect(
            renderControl(control, context, "main", agent).querySelector(
              '[data-chat-model-runtime="codex"]',
            ),
          ).not.toBeNull(),
        );
        renderControl(control, context, "main", agent)
          .querySelector<HTMLButtonElement>('[data-chat-model-runtime="codex"]')!
          .click();
        expect(control.selected).toBe("openai/gpt-5.6-sol");
        expect(control.agentRuntime).toBe("codex");
        renderControl(control, context, "main", agent)
          .querySelector<HTMLButtonElement>('[data-chat-context-window-toggle="64k"]')!
          .click();
        expect(control.contextWindow).toBe("64k");
        const changesBeforeReselect = changed.mock.calls.length;
        renderControl(control, context, "main", agent)
          .querySelector<HTMLButtonElement>('[data-chat-model-runtime="codex"]')!
          .click();
        expect(control.contextWindow).toBe("64k");
        expect(changed).toHaveBeenCalledTimes(changesBeforeReselect);
        expect(control.resolveAgentRuntime({ agent, context })?.cloudPlacementExecutionMode).toBe(
          "remote-exec",
        );
        expect(
          control.cloudRuntimeUnsupportedReason({
            id: "worker",
            providerId: "example",
            executionModes: ["worker-turn"],
          }),
        ).toContain("codex runtime");
        const selected = renderControl(control, context, "main", agent);
        expect(
          selected.querySelectorAll('[data-chat-model-option][aria-selected="true"]'),
        ).toHaveLength(1);
        expect(
          selected
            .querySelector('[data-chat-model-runtime="codex"]')
            ?.getAttribute("aria-selected"),
        ).toBe("true");
        expect(selected.querySelector('[data-chat-thinking-option="medium"]')).toBeNull();
        expect(loadNewSessionPreference(gatewayUrl, "main")).toMatchObject({
          model: "openai/gpt-5.6-sol",
          agentRuntime: "codex",
        });
        expect(
          buildDraftSessionCreateParams({
            agentId: "main",
            message: "hello",
            worktree: false,
            model: control.modelForSubmission(),
            agentRuntime: control.agentRuntime,
          }),
        ).toMatchObject({ model: "openai/gpt-5.6-sol", agentRuntime: "codex" });
        control.reset();
        control.load(context, "main", true, {
          agent,
          preference: loadNewSessionPreference(gatewayUrl, "main"),
        });
        await vi.waitFor(() => expect(control.agentRuntime).toBe("codex"));
        renderControl(control, context, "main", agent)
          .querySelector<HTMLButtonElement>('[data-chat-model-default="true"]')!
          .click();
        expect(control.modelForSubmission()).toBe("");
        expect(control.agentRuntime).toBeUndefined();
        expect(loadNewSessionPreference(gatewayUrl, "main")?.agentRuntime).toBeUndefined();
      } finally {
        control.reset();
        localStorage.removeItem(`openclaw.new-session.preferences.v1:${gatewayUrl}`);
      }
    });

    it("blocks a saved runtime that is no longer offered instead of silently selecting the default", async () => {
      const { runtimeChoices: _choices, ...base } = models[0]!;
      const { context } = contextWith([base]);
      const changed = vi.fn();
      const control = new NewSessionModelControl(() => undefined, changed);
      control.load(context, "main", true, {
        agent,
        preference: { model: "openai/gpt-5.6-sol", agentRuntime: "codex" },
      });
      try {
        await vi.waitFor(() =>
          expect(control.modelSelectionBlockedReason(agent)).toBe("Models unavailable"),
        );
        expect(control.agentRuntime).toBe("codex");
        expect(control.modelForSubmission()).toBe("openai/gpt-5.6-sol");
        expect(changed).not.toHaveBeenCalled();
      } finally {
        control.reset();
      }
    });
  });
});
