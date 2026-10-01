import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayAgentRow, ModelCatalogEntry } from "../../api/types.ts";
import { contextWith, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";

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

  it("selects a context window and clears it when switching draft models", async () => {
    const { control, context, find } = setup([
      luna,
      {
        id: "claude-fable-5",
        name: "Claude Fable 5",
        provider: "anthropic",
        contextWindow: 1_000_000,
        contextWindows: [
          { id: "200k", label: "200K", contextWindow: 200_000 },
          { id: "1m", label: "1M", contextWindow: 1_000_000 },
        ],
        contextWindowDefault: "1m",
      },
    ]);
    control.load(context, "main", true);
    await vi.waitFor(() =>
      expect(find('[data-chat-model-option="anthropic/claude-fable-5"]')).not.toBeNull(),
    );
    find('[data-chat-model-option="anthropic/claude-fable-5"]')!.click();
    const toggle = find('[data-chat-context-window-toggle="200k"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    toggle.click();
    expect(control.contextWindow).toBe("200k");
    find('[data-chat-model-option="openai/gpt-5.6-luna"]')!.click();
    expect(control.contextWindow).toBe("");
    expect(find("[data-chat-context-window-toggle]")).toBeNull();
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
    expect(trigger.getAttribute("aria-label")).toBe("Chat model: Checking models…");
    expect(trigger.querySelector(".skeleton")?.getAttribute("aria-hidden")).toBe("true");
    expect(trigger.textContent).not.toMatch(/Checking models|Default model/);
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

  it("uses the catalog thinking profile without inventing Medium", async () => {
    const { control, context, draw } = setup([
      {
        id: "published",
        name: "Published thinking",
        provider: "thinking-fixture",
        reasoning: true,
        thinkingLevels: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
        thinkingDefault: "high",
      },
    ]);
    const agent = { id: "main", model: { primary: "thinking-fixture/published" } };
    control.load(context, "main", true, { agent });
    await vi.waitFor(() => expect(draw(agent).textContent).toContain("Published thinking"));
    const container = draw(agent);
    expect(container.querySelector("[data-chat-thinking-select]")?.textContent).toContain("High");
    expect(container.querySelector("[data-chat-thinking-select]")?.textContent).not.toContain(
      "Medium",
    );
    expect(
      container
        .querySelector("[data-chat-thinking-slider]")
        ?.getAttribute("data-chat-thinking-values"),
    ).toBe("low,high");
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

  it("preserves the remembered pair when metadata validation fails", async () => {
    const { control, context, request } = setup([]);
    request.mockRejectedValueOnce(new Error("metadata unavailable"));
    control.load(context, "main", true, {
      preference: { model: "anthropic/claude-sonnet-4-6", thinkingLevel: "high" },
    });
    expect(control.isRestoringPreference()).toBe(true);
    await vi.waitFor(() => expect(control.isRestoringPreference()).toBe(false));
    expect(control.selected).toBe("anthropic/claude-sonnet-4-6");
    expect(control.thinkingLevel).toBe("high");
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

  it.each(["missing", "denied"])(
    "drops a stored model and reasoning when the model is %s",
    async (state) => {
      const { control, context, request, changed } = setup([
        sol,
        ...(state === "denied"
          ? [
              {
                id: "retired-model",
                name: "Retired model",
                provider: "anthropic",
                manualSelectionAllowed: false,
              },
            ]
          : []),
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
    },
  );

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
  it.each(["picker", "error action"])(
    "retries failed discovery from the %s without refreshing models",
    async (action) => {
      const { control, context, request, find, draw, targetSelected } = setup(
        [luna],
        ["sessions.catalog.list"],
      );
      const catalogs = vi
        .fn()
        .mockRejectedValueOnce(new Error("unavailable"))
        .mockResolvedValue({
          catalogs:
            action === "picker" ? [] : [catalog("anthropic"), catalog("history-only", false)],
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
      if (action === "picker") {
        const picker = draw().querySelector<HTMLDetailsElement>(".chat-controls__model-picker")!;
        picker.open = true;
        picker.dispatchEvent(new Event("toggle"));
      } else {
        find('[data-chat-model-target-retry="cliAgents"]')!.click();
      }
      await vi.waitFor(() =>
        expect(
          find(
            '[data-chat-model-target-group="cliAgents"] [data-chat-model-catalog-state="error"]',
          ),
        ).toBeNull(),
      );
      expect(catalogs).toHaveBeenCalledTimes(2);
      expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(1);
      expect(request.mock.calls.some(([, params]) => params?.refresh)).toBe(false);
      if (action === "error action") {
        expect(find('[data-chat-model-target="history-only"]')).toBeNull();
        find('[data-chat-model-target="anthropic"]')!.click();
        expect(targetSelected).toHaveBeenCalledExactlyOnceWith("anthropic");
      }
      control.loadCatalogTargets(context, "main", true);
      expect(catalogs).toHaveBeenCalledTimes(2);
    },
  );

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
      executionModes: ["worker-turn"] as const,
      expected:
        "The codex runtime cannot use this cloud worker. Choose a compatible cloud worker or run locally.",
    },
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
