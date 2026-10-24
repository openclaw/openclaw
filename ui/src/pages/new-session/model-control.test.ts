import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayAgentRow, ModelCatalogEntry } from "../../api/types.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  managedModelControls,
  controlElement,
  controlQueries,
  testModel,
  thinkingLevels as levels,
} from "./model-control-view-queries.test-support.ts";
import { contextWith, renderControl } from "./model-control.test-support.ts";
import type { NewSessionModelLoadOptions } from "./model-selection.ts";
import * as modelTarget from "./model-target.ts";
import { loadNewSessionPreference, replaceBrowserPreference } from "./preferences.ts";

const luna = { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" };
const sol = { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", reasoning: true };
const effortAgent = {
  id: "main",
  model: { primary: "openai/gpt-5.6-sol" },
  thinkingLevels: levels(["off", "high"], true),
  thinkingDefault: "high",
};
const managed = managedModelControls();
function setup(
  models: ModelCatalogEntry[],
  methods: string[] = [],
  defaultAgent?: GatewayAgentRow,
) {
  const state = contextWith(models, "openclaw", methods);
  const changed = vi.fn();
  const targetSelected = vi.fn();
  const control = managed.make(() => undefined, changed, targetSelected);
  const draw = (agent: GatewayAgentRow | null | undefined = defaultAgent) =>
    renderControl(control, state.context, "main", agent);
  const find = (attribute: string, value?: string) => controlElement(draw(), attribute, value);
  const load = (options: NewSessionModelLoadOptions = {}) =>
    control.load(state.context, "main", true, { agent: defaultAgent, ...options });
  const ready = async (options?: NewSessionModelLoadOptions) => {
    load(options);
    await vi.waitFor(() => expect(find("model-option")).not.toBeNull());
  };
  return { ...state, control, changed, targetSelected, draw, find, load, ready };
}
afterEach(() => {
  managed.reset();
  vi.restoreAllMocks();
});

it("reuses runtime resolution until model inputs change, including mutable defaults", async () => {
  const local = { id: "local", source: "model" as const };
  const hosted = { id: "hosted", source: "model" as const };
  const { control, context, request } = setup([
    { ...luna, agentRuntime: local },
    { ...sol, agentRuntime: hosted },
  ]);
  const agent = { id: "main", model: { primary: "openai/gpt-5.6-luna" } };
  control.load(context, "main", true, { agent });
  await vi.waitFor(() => expect(control.resolveAgentRuntime()?.id).toBe("local"));
  const resolve = vi.spyOn(modelTarget, "resolveDraftAgentRuntime");
  for (let index = 0; index < 50; index += 1) {
    expect(control.resolveAgentRuntime()?.id).toBe("local");
  }
  expect(resolve).not.toHaveBeenCalled();

  agent.model.primary = "openai/gpt-5.6-sol";
  expect(control.resolveAgentRuntime()?.id).toBe("hosted");
  expect(resolve).toHaveBeenCalledTimes(1);
  control.selectModel("openai/gpt-5.6-luna");
  expect(control.resolveAgentRuntime()?.id).toBe("local");

  control.selectModel("");
  delete (agent as { model?: unknown }).model;
  const defaults = context.sessions.state.result!.defaults!;
  defaults.model = "gpt-5.6-sol";
  defaults.modelProvider = "openai";
  expect(control.resolveAgentRuntime()?.id).toBe("hosted");
  defaults.model = "gpt-5.6-luna";
  expect(control.resolveAgentRuntime()?.id).toBe("local");

  request.mockResolvedValue({ models: [{ ...luna, agentRuntime: hosted }] });
  control.invalidate();
  control.load(context, "main", true, { agent });
  await vi.waitFor(() => expect(control.resolveAgentRuntime()?.id).toBe("hosted"));
  control.reset();
  expect(control.resolveAgentRuntime()?.id).not.toBe("hosted");
});

it("does not borrow a provider for an ambiguous draft target", async () => {
  const { control, context, ready } = setup([
    testModel("openai", "model", {
      reasoning: true,
      thinkingLevels: levels(["high"]),
      thinkingDefault: "high",
    }),
    testModel("alternate-fixture", "model", { reasoning: true }),
  ]);
  Object.assign(context.sessions.state.result!.defaults, {
    model: "other",
    modelProvider: "openai",
  });
  const agent = { id: "main", model: { primary: "model" } };
  await ready({ agent });
  const { find: agentOption } = controlQueries(control, context, "main", agent);
  await vi.waitFor(() => expect(agentOption("model-option", "openai/model")).not.toBeNull());
  expect(agentOption("thinking-option", "high")).toBeNull();
  expect(agentOption("thinking-slider")).toBeNull();
});

it("waits for selected-agent defaults after catalog hydration", async () => {
  const { control, draw, ready: load } = setup([{ ...luna, reasoning: true }, sol]);
  await load();
  const loading = draw(null);
  const trigger = loading.querySelector("[data-chat-model-select]")!;
  expect(trigger.getAttribute("aria-busy")).toBe("true");
  expect(controlElement(loading, "thinking-select")?.dataset.chatThinkingDisabled).toBe("true");
  const ready = draw(effortAgent);
  expect(controlElement(ready, "model-default", "true")?.textContent).toContain(sol.name);
  expect(controlElement(ready, "thinking-select")?.textContent).toContain("High");
  expect(control).toMatchObject({ selected: "", thinkingLevel: "" });
});

it("preserves an explicitly remembered Off effort", async () => {
  const { control, find, ready } = setup([sol], [], effortAgent);
  await ready({ preference: { thinkingLevel: "off" } });
  expect(find("thinking-select")?.textContent).toContain("Off");
  expect(control.selected).toBe("");
});

it("renders an all-cold catalog as setup actions", async () => {
  const { draw, find, navigate, ready } = setup([
    { ...luna, available: false, unavailableReason: "missing-auth" },
  ]);
  await ready();
  const container = draw();
  expect(container.querySelector("[data-chat-model-select]")?.textContent).toContain(luna.name);
  expect(container.querySelectorAll("[data-chat-model-option]")).toHaveLength(1);
  expect(find("model-option")).toMatchObject({
    disabled: false,
    textContent: expect.stringContaining("Sign-in needed"),
    dataset: { chatModelSetup: "true" },
  });
  expect(container.textContent).toContain("No models available");
  find("model-setup", "true")!.click();
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
  expect(find("model-catalog-state")).toBeNull();
  expect(find("model-option", "openai/gpt-5.6-sol")?.disabled).toBe(false);
  find("model-option", "openai/gpt-5.6-sol")!.click();
  expect(control.selected).toBe("openai/gpt-5.6-sol");
  refresh.reject(new Error("refresh failed"));
  await vi.waitFor(() => expect(find("model-catalog-state", "error")).not.toBeNull());
  expect(draw().querySelectorAll("[data-chat-model-option]")).toHaveLength(2);
  expect(find("model-select")?.textContent).toContain(sol.name);
  const picker = draw().querySelector<HTMLDetailsElement>(".chat-controls__model-picker")!;
  picker.open = true;
  picker.dispatchEvent(new Event("toggle"));
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  await vi.waitFor(() => expect(find("model-catalog-state")).toBeNull());
  expect(draw().querySelectorAll("[data-chat-model-option]")).toHaveLength(2);
  expect(control.selected).toBe("openai/gpt-5.6-sol");
});

it("drops a stored model and reasoning when manual selection is denied", async () => {
  const { control, load, ready } = setup([
    sol,
    testModel("anthropic", "retired-model", { manualSelectionAllowed: false }),
  ]);
  await ready({
    preference: { model: "openai/gpt-5.6-sol", thinkingLevel: "high" },
  });
  expect(control).toMatchObject({ selected: "openai/gpt-5.6-sol", thinkingLevel: "high" });
  load({
    preference: { model: "anthropic/retired-model", thinkingLevel: "high" },
  });
  expect(control).toMatchObject({ selected: "", thinkingLevel: "" });
});

it("clears xhigh when an interactive model switch targets a profile ending at high", async () => {
  const { control, ready, find } = setup([
    testModel("kimi", "k3", {
      reasoning: true,
      thinkingLevels: levels(["off", "low", "medium", "high", "xhigh"]),
      thinkingDefault: "high",
    }),
    testModel("demo", "limited", {
      reasoning: true,
      thinkingLevels: levels(["off", "low", "medium", "high"]),
      thinkingDefault: "medium",
    }),
  ]);
  await ready();
  control.selected = "kimi/k3";
  control.thinkingLevel = "xhigh";
  find("model-option", "demo/limited")!.click();
  expect(control).toMatchObject({ selected: "demo/limited", thinkingLevel: "" });
});
const catalog = (id: string, startTerminal = true) => ({
  id,
  label: id,
  capabilities: { startTerminal },
  hosts: [],
});
it("retries failed discovery from the error action without refreshing models", async () => {
  const { control, context, request, find, draw, targetSelected } = setup(
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
  await vi.waitFor(() => expect(find("model-target-retry", "cliAgents")).not.toBeNull());
  control.loadCatalogTargets(context, "main", true);
  find("model-target-retry", "cliAgents")!.click();
  await vi.waitFor(() =>
    expect(
      draw().querySelector(
        '[data-chat-model-target-group="cliAgents"] [data-chat-model-catalog-state="error"]',
      ),
    ).toBeNull(),
  );
  await vi.waitFor(() => expect(find("model-target", "anthropic")).not.toBeNull());
  expect(find("model-target", "history-only")).toBeNull();
  find("model-target", "anthropic")!.click();
  expect(targetSelected).toHaveBeenCalledExactlyOnceWith("anthropic");
});

it("omits a completed CLI group with no terminal-capable targets", async () => {
  const discovery = deferred<{ catalogs: ReturnType<typeof catalog>[] }>();
  const { control, context, request, draw } = setup([luna], ["sessions.catalog.list"]);
  request.mockImplementation(() => discovery.promise);
  control.loadCatalogTargets(context, "main", true);
  await vi.waitFor(() =>
    expect(draw().querySelector('[data-chat-model-target-group="cliAgents"]')).not.toBeNull(),
  );
  discovery.resolve({ catalogs: [catalog("history-only", false)] });
  await vi.waitFor(() =>
    expect(draw().querySelector('[data-chat-model-target-group="cliAgents"]')).toBeNull(),
  );
});

it.each([false, true])(
  "fences late CLI discovery after A to B (return to A=%s)",
  async (returnToA) => {
    const retired = deferred<{ catalogs: ReturnType<typeof catalog>[] }>();
    const current = deferred<{ catalogs: ReturnType<typeof catalog>[] }>();
    const { control, context, request, find } = setup([luna], ["sessions.catalog.list"]);
    request
      .mockImplementationOnce(() => retired.promise)
      .mockImplementationOnce(() =>
        returnToA ? Promise.resolve({ catalogs: [catalog("research")] }) : current.promise,
      )
      .mockImplementationOnce(() => current.promise);
    control.loadCatalogTargets(context, "main", true);
    control.loadCatalogTargets(context, "research", true);
    if (returnToA) {
      control.loadCatalogTargets(context, "main", true);
    }
    current.resolve({ catalogs: [catalog("current")] });
    await vi.waitFor(() => expect(find("model-target", "current")).not.toBeNull());
    retired.resolve({ catalogs: [catalog("stale")] });
    await retired.promise;
    flush();
    expect(find("model-target", "current")).not.toBeNull();
    expect(find("model-target", "stale")).toBeNull();
  },
);
describe("configured defaults", () => {
  const models = ["default-model", "other-model"].map((id) =>
    testModel("openai", id, {
      reasoning: true,
      supportsFastMode: true,
    }),
  );
  const agent = { id: "main", model: { primary: "openai/default-model" }, thinkingDefault: "high" };
  const preference = { model: "openai/other-model", thinkingLevel: "low", fastMode: true };
  const savedDraft = { agentId: "main", model: preference.model, thinkingLevel: "low" };
  function setupDefaults() {
    const state = setup(models, [], agent);
    Object.assign(state.context, {
      config: { ...state.context.config, current: { newSessionModelDefaults: "configured" } },
    });
    return {
      ...state,
      load: (options: NewSessionModelLoadOptions = {}, id = "main") =>
        state.control.load(state.context, id, true, { agent, preference, ...options }),
      settled: () => waitForFast(() => expect(state.control.isRestoringPreference()).toBe(false)),
    };
  }

  it("preserves URL intent until the next agent", async () => {
    const { control, load, settled } = setupDefaults();
    load({ initialModel: preference.model });
    await settled();
    expect(control.modelForSubmission()).toBe(preference.model);
    load();
    await settled();
    expect(control.selected).toBe(preference.model);
    load({ agent: { ...agent, id: "other" } }, "other");
    await settled();
    expect(control.selected).toBe("");
  });

  it("withholds stale preferences after metadata failure", async () => {
    const { request, control, load, settled } = setupDefaults();
    request.mockRejectedValue(new Error("offline"));
    load({ preference: { ...preference, agentRuntime: "stale-runtime" } });
    await settled();
    expect(control).toMatchObject({ selected: "", agentRuntime: undefined, thinkingLevel: "" });
  });

  it("restores deliberate same-route intent across catalog hydration and reload", async () => {
    const { control, load, settled } = setupDefaults();
    control.restoreDraftSelection(savedDraft);
    load({ initialModel: "openai/default-model" });
    await settled();
    expect(control.draftSelection("main")).toMatchObject(savedDraft);
    load();
    expect(control).toMatchObject({ selected: savedDraft.model, thinkingLevel: "low" });
  });

  it("hydrates late Fast Mode preferences independently of a restored model", async () => {
    const { request, control, find, load, settled } = setupDefaults();
    const catalogRead = deferred<{ models: typeof models }>();
    request.mockReturnValue(catalogRead.promise);
    load({ preference: null });
    control.restoreDraftSelection(savedDraft);
    load();
    catalogRead.resolve({ models });
    await settled();
    expect(control.fastMode).toBe(true);
    find("speed-option", "off")!.click();
    expect(control.fastMode).toBe(false);
    load();
    expect(control.fastMode).toBe(false);
  });

  it("retires a consumed restored choice but preserves a newer deliberate choice", async () => {
    const { control, find, load, settled } = setupDefaults();
    load();
    await settled();
    control.restoreDraftSelection(savedDraft);
    expect(control.selected).toBe(savedDraft.model);
    control.restoreDraftSelection(undefined);
    expect(control).toMatchObject({
      selected: "",
      thinkingLevel: "",
      agentRuntime: undefined,
      fastMode: true,
    });
    expect(control.draftSelection("main")).toBeUndefined();
    control.restoreDraftSelection(savedDraft);
    find("model-option", "openai/default-model")!.click();
    control.restoreDraftSelection(undefined);
    expect(control.draftSelection("main")).toMatchObject({ model: "", thinkingLevel: "low" });
  });
});
it.each(["auto", "ultrafast"] as const)(
  "restores a standalone speed preference %s",
  async (fastMode) => {
    const { context, control, draw } = setup([
      { ...luna, reasoning: true, available: true, serviceTiers: ["ultrafast"] },
    ]);
    control.load(context, "main", true, { preference: { fastMode } });
    expect(control.isRestoringPreference()).toBe(true);
    await waitForFast(() => expect(control.fastMode).toBe(fastMode));
    expect(
      draw()
        .querySelector('[data-chat-speed-option][aria-checked="true"]')
        ?.getAttribute("data-chat-speed-option"),
    ).toBe(fastMode === "auto" ? undefined : fastMode);
    control.load(context, "other", true);
    expect(control.fastMode).toBeUndefined();
  },
);

it.each([
  testModel("ollama", "llama-4"),
  testModel("openai", "standard-only", { supportsFastMode: false, serviceTiers: ["default"] }),
  testModel("openai", "fast", { supportsFastMode: true, serviceTiers: ["default", "priority"] }),
])("reconciles speed when switching to $provider/$id", async (model) => {
  const { control, ready, find } = setup([{ ...luna, supportsFastMode: true }, model]);
  await ready();
  find("speed-option", "on")!.click();
  expect(control.fastMode).toBe(true);
  find("model-option", `${model.provider}/${model.id}`)!.click();
  expect(control.selected).toBe(`${model.provider}/${model.id}`);
  expect(control.fastMode).toBe(model.supportsFastMode ? true : undefined);
  if (model.provider === "ollama") {
    expect(find("speed-option")).toBeNull();
  }
});

describe("runtime choices", () => {
  const agent: GatewayAgentRow = { id: "main", model: { primary: "openai/gpt-5.6-sol" } };
  const runtime = (id: string, cloudPlacementExecutionMode: "worker-turn" | "remote-exec") => ({
    id,
    source: "model" as const,
    cloudPlacementSupported: true,
    cloudPlacementExecutionMode,
  });
  const models: ModelCatalogEntry[] = [
    {
      id: sol.id,
      provider: sol.provider,
      name: sol.name,
      available: true,
      contextWindow: 1_000_000,
      agentRuntime: runtime("openclaw", "worker-turn"),
      thinkingLevels: levels(["medium"], true),
      thinkingDefault: "medium",
      supportsTools: true,
      runtimeChoices: [
        {
          agentRuntime: runtime("codex", "remote-exec"),
          available: true,
          contextWindow: 200_000,
          contextWindows: [
            { id: "64k", label: "64K", contextWindow: 64_000 },
            { id: "200k", label: "200K", contextWindow: 200_000 },
          ],
          contextWindowDefault: "200k",
          thinkingLevels: levels(["high"], true),
          thinkingDefault: "high",
        },
      ],
    },
  ];

  it("keeps the same-name runtime choice through preferences and create while using its own capabilities", async () => {
    const { context } = contextWith(models);
    const gatewayUrl = "ws://runtime-choice.example";
    const changed = vi.fn((selection) =>
      replaceBrowserPreference(gatewayUrl, "main", {
        ...loadNewSessionPreference(gatewayUrl, "main"),
        ...selection,
      }),
    );
    const control = managed.make(() => undefined, changed);
    const { draw, find } = controlQueries(control, context, "main", agent);
    control.load(context, "main", true, { agent });
    try {
      await vi.waitFor(() => expect(find("model-runtime", "codex")).not.toBeNull());
      find("model-runtime", "codex")!.click();
      expect(control).toMatchObject({ selected: "openai/gpt-5.6-sol", agentRuntime: "codex" });
      find("context-window-toggle", "64k")!.click();
      expect(control.contextWindow).toBe("64k");
      const changesBeforeReselect = changed.mock.calls.length;
      find("model-runtime", "codex")!.click();
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
      const selected = draw();
      expect(
        selected.querySelectorAll('[data-chat-model-option][aria-selected="true"]'),
      ).toHaveLength(1);
      expect(find("model-runtime", "codex")?.getAttribute("aria-selected")).toBe("true");
      expect(find("thinking-option", "medium")).toBeNull();
      expect(loadNewSessionPreference(gatewayUrl, "main")).toMatchObject({
        model: "openai/gpt-5.6-sol",
        agentRuntime: "codex",
      });
      expect(control.modelForSubmission()).toBe("openai/gpt-5.6-sol");
      control.reset();
      control.load(context, "main", true, {
        agent,
        preference: loadNewSessionPreference(gatewayUrl, "main"),
      });
      await vi.waitFor(() => expect(control.agentRuntime).toBe("codex"));
      find("model-default", "true")!.click();
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
    const control = managed.make(() => undefined, changed);
    control.load(context, "main", true, {
      agent,
      preference: { model: "openai/gpt-5.6-sol", agentRuntime: "codex" },
    });

    await vi.waitFor(() =>
      expect(control.modelSelectionBlockedReason(agent)).toBe("Models unavailable"),
    );
    expect(control.agentRuntime).toBe("codex");
    expect(control.modelForSubmission()).toBe("openai/gpt-5.6-sol");
    expect(changed).not.toHaveBeenCalled();
  });
});
