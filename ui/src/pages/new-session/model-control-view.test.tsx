import { createSignal, flush, untrack } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ModelCatalogResult } from "../../api/types.ts";
import { i18n, t } from "../../i18n/index.ts";
import { mergeCatalog } from "../../i18n/lib/merge-catalog.ts";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import { en } from "../../i18n/locales/en.ts";
import { invalidateModelCatalogCache } from "../../lib/model-catalog-cache.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { installModelPickerLayout } from "../../test-helpers/model-picker-layout.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { NewSessionModelControlView } from "./model-control-view.tsx";
import { contextWith, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl, type NewSessionModelRenderOptions } from "./model-control.ts";

async function focusModelSearch(container: HTMLElement) {
  const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker")!;
  await waitForSolid(() => expect(picker.hasAttribute("data-chat-native-picker")).toBe(true));
  // The shared fixture also opens Effort, which closes the exclusive model menu.
  if (!picker.open) {
    picker.querySelector<HTMLElement>("[data-chat-model-select]")!.click();
    flush();
  }
  expect(picker.open).toBe(true);
  const input = picker.querySelector<HTMLInputElement>("[data-chat-model-search]")!;
  input.focus();
  expect(document.activeElement).toBe(input);
  return input;
}

it("keeps one mounted model view live without depending on draft revisions", async () => {
  installModelPickerLayout();
  const model = { id: "gpt-5.5", name: "GPT 5.5", provider: "openai", reasoning: true };
  const models = [model, { ...model, id: "fixture-alternative", name: "Alternative" }];
  const alternate = "openai/fixture-alternative";
  const first = contextWith(models);
  const second = contextWith(models);
  const { sessions, gateway } = first.context;
  const client = gateway.snapshot.client!;
  const control = new NewSessionModelControl(() => undefined);
  const agent = { id: "main", model: { primary: "openai/gpt-5.5" } };
  control.load(first.context, "main", true, { agent });
  const [options, setOptions] = createSignal<NewSessionModelRenderOptions>({
    agent,
    agentId: "main",
    context: first.context,
    sending: false,
  });
  await waitForFast(() =>
    expect(control.renderProps(untrack(options)).modelCatalog).toHaveLength(2),
  );
  const view = mountSolid(() => (
    <NewSessionModelControlView control={control} options={options()} />
  ));
  const query = (selector: string) => view.container.querySelector(selector);
  const controlValue = (kind: "model" | "thinking") =>
    query(`[data-chat-${kind}-select]`)?.getAttribute(
      kind === "model" ? "data-chat-select-value" : "data-chat-thinking-value",
    );
  const publish = (owner: Parameters<typeof first.publish>[0]) => {
    first.publish(owner);
    flush();
  };
  const render = vi.spyOn(control, "renderProps");
  try {
    setOptions((previous) => ({ ...previous }));
    await Promise.resolve();
    expect(render).not.toHaveBeenCalled();
    for (const owner of ["gateway", "agents", "config"] as const) {
      first.publish(owner);
      await waitForFast(() => expect(render).toHaveBeenCalled());
      render.mockClear();
    }
    const trigger = () => query("[data-chat-model-select]");
    const option = () => query('[data-chat-model-option="openai/gpt-5.5"]');
    const mountedTrigger = trigger();
    await waitForSolid(() =>
      expect(query(".chat-controls__model-picker")?.hasAttribute("data-chat-native-picker")).toBe(
        true,
      ),
    );
    mountedTrigger?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    flush();
    expect(query(".chat-controls__model-picker")?.hasAttribute("open")).toBe(true);
    // First open resolves the lazy picker panel before option identity can be checked.
    await waitForSolid(() => expect(option()).not.toBeNull(), { timeout: 5_000 });
    const mountedOption = option();
    render.mockClear();
    const labels = vi.spyOn(String.prototype, "toLocaleLowerCase");
    try {
      // A lazy view can register unrelated copy while the model picker is retained.
      registerEnglishCatalog(() => undefined);
      flush();
      const result = sessions.state.result!;
      result.sessions.push({ key: "agent:main:unrelated", kind: "direct", label: "Background" });
      first.publish("sessions");
      invalidateModelCatalogCache(client, { agentId: "main", sessionKey: "agent:main:unrelated" });
      flush();
      expect(render).not.toHaveBeenCalled();
      expect(labels.mock.contexts.filter((value) => String(value) === "GPT 5.5")).toHaveLength(0);
      expect(trigger()).toBe(mountedTrigger);
      expect(option()).toBe(mountedOption);

      // A default can change in place: filtering row traffic must not freeze it.
      agent.model.primary = "";
      publish("agents");
      result.defaults.model = "fixture-alternative";
      publish("sessions");
      expect(trigger()?.textContent).toContain("Alternative");
      render.mockClear();
      sessions.state.result = { ...result, defaults: { ...result.defaults } };
      publish("sessions");
      expect(render).not.toHaveBeenCalled();
    } finally {
      labels.mockRestore();
    }
    invalidateModelCatalogCache(client, { agentId: "main" });
    flush();
    expect(render).toHaveBeenCalled();
    render.mockClear();
    for (const sending of [true, false]) {
      setOptions((previous) => ({ ...previous, sending }));
      await waitForFast(() =>
        expect(render).toHaveBeenLastCalledWith(expect.objectContaining({ sending })),
      );
    }
    control.selectModel(alternate);
    await waitForFast(() => expect(controlValue("model")).toBe(alternate));
    const current = control.renderProps(untrack(options));
    current.onThinkingSelect?.("high", current.sessionKey);
    await waitForFast(() => expect(controlValue("thinking")).toBe("high"));
    for (const [phase, disabled] of [
      ["offline", "true"],
      ["connected", "false"],
    ] as const) {
      gateway.snapshot.phase = phase;
      first.publish("gateway");
      await waitForFast(() => expect(trigger()?.getAttribute("aria-disabled")).toBe(disabled));
    }
    setOptions((previous) => ({ ...previous, context: second.context }));
    await waitForFast(() => expect(second.ownerListeners.gateway.size).toBe(1));
    expect(Object.values(first.ownerListeners).every((listeners) => listeners.size === 0)).toBe(
      true,
    );
    render.mockClear();
    first.publish("gateway");
    await Promise.resolve();
    expect(render).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    control.reset();
    render.mockRestore();
  }
  expect(Object.values(second.ownerListeners).every((listeners) => listeners.size === 0)).toBe(
    true,
  );
});

it("refreshes retained runtime labels, descriptions, and search without new props", async () => {
  const restoreI18n = captureI18nStateForTesting();
  onTestFinished(restoreI18n);
  await i18n.setLocale("en");
  installModelPickerLayout();
  const models = [
    {
      id: "model-0",
      name: "Model 0",
      provider: "anthropic",
      contextTokens: 1_000,
      contextWindow: 2_000,
    },
  ];
  const { context } = contextWith(models);
  const agent = { id: "main", model: { primary: "anthropic/model-0" } };
  const control = new NewSessionModelControl(() => undefined);
  control.load(context, "main", true, { agent });
  const options = { agent, agentId: "main", context, sending: false };
  await waitForFast(() => expect(control.renderProps(options).modelCatalog).toHaveLength(1));
  const view = mountSolid(() => <NewSessionModelControlView control={control} options={options} />);
  const option = () =>
    view.container.querySelector<HTMLButtonElement>('[data-chat-model-option="anthropic/model-0"]');
  const labelKey = "chat.modelControls.routes.anthropicConfigured.label";
  const detailKey = "chat.modelControls.routes.anthropicConfigured.detail";
  const contextKey = "chat.modelControls.contextActiveAndMax";
  const original = { label: t(labelKey), detail: t(detailKey), context: t(contextKey) };
  const installRoute = (label: string, detail: string, contextLabel = original.context) =>
    registerEnglishCatalog(() =>
      mergeCatalog(en, {
        chat: {
          modelControls: {
            contextActiveAndMax: contextLabel,
            routes: { anthropicConfigured: { label, detail } },
          },
        },
      }),
    );
  try {
    const picker = view.container.querySelector<HTMLDetailsElement>(
      ".chat-controls__model-picker",
    )!;
    await waitForSolid(() => expect(picker.hasAttribute("data-chat-native-picker")).toBe(true));
    picker.querySelector<HTMLElement>("[data-chat-model-select]")!.click();
    await waitForSolid(() => expect(option()).not.toBeNull(), { timeout: 5_000 });
    const search = await focusModelSearch(view.container);
    const mountedOption = option();
    const rendered = vi.spyOn(control, "renderProps");
    try {
      // Keep the locale and every other model label unchanged: only this route's copy changes.
      installRoute("Synthetic runtime label", original.detail);
      await waitForSolid(() =>
        expect(option()?.getAttribute("aria-label")).toContain("Synthetic runtime label"),
      );
      search.value = "Synthetic runtime label";
      search.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await waitForSolid(() => expect(option()?.hidden).toBe(false));
      expect(option()).toBe(mountedOption);
      search.value = "";
      search.dispatchEvent(new InputEvent("input", { bubbles: true }));
      installRoute("Synthetic runtime label", "Synthetic runtime detail");
      await waitForSolid(() =>
        expect(option()?.closest("openclaw-tooltip")?.content).toBe("Synthetic runtime detail"),
      );
      installRoute(
        "Synthetic runtime label",
        "Synthetic runtime detail",
        "{active} test active / {maximum} test max",
      );
      await waitForSolid(() =>
        expect(option()?.textContent).toContain("1k test active / 2k test max"),
      );
      installRoute(original.label, original.detail);
      await i18n.setLocale("de");
      const translatedLabel = t(labelKey);
      expect(translatedLabel).not.toBe(original.label);
      await waitForSolid(() => {
        expect(option()?.getAttribute("aria-label")).toContain(translatedLabel);
        expect(option()?.closest("openclaw-tooltip")?.content).toBe(t(detailKey));
        expect(option()?.textContent).toContain(t(contextKey, { active: "1k", maximum: "2k" }));
      });
      search.value = translatedLabel;
      search.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await waitForSolid(() => expect(option()?.hidden).toBe(false));
      expect(view.container.querySelector("[data-chat-model-search]")).toBe(search);
      expect(rendered).not.toHaveBeenCalled();
    } finally {
      rendered.mockRestore();
    }
  } finally {
    view.unmount();
    control.reset();
    installRoute(original.label, original.detail);
  }
});

it("keeps CLI targets and a typed search live while initial model metadata is pending", async () => {
  const catalog = deferred<ModelCatalogResult>();
  const state = contextWith([], "openclaw", ["sessions.catalog.list"]);
  const agent = { id: "main", model: { primary: "example/current" } };
  Object.assign(state.context.sessions.state.result!.defaults, {
    model: "example/current",
    modelProvider: "example",
  });
  state.request.mockImplementation((method: string) =>
    method === "sessions.catalog.list"
      ? Promise.resolve({
          catalogs: [
            { id: "fixture-cli", label: "Fixture CLI", capabilities: { startTerminal: true } },
          ],
        })
      : catalog.promise,
  );
  const control = new NewSessionModelControl(() => undefined);
  control.load(state.context, "main", true, { agent });
  control.loadCatalogTargets(state.context, "main", true);
  const container = renderControl(control, state.context, "main", agent);
  try {
    const target = () =>
      container.querySelector<HTMLButtonElement>('[data-chat-model-target="fixture-cli"]');
    await waitForSolid(() => expect(target()).not.toBeNull());
    const input = await focusModelSearch(container);
    input.value = "Fixture CLI";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flush();
    expect(target()?.hidden).toBe(false);
    expect(container.querySelector('[data-chat-model-option="example/extra"]')).toBeNull();
    catalog.resolve({
      models: [
        { provider: "example", id: "current", name: "Current model" },
        { provider: "example", id: "extra", name: "Extra model" },
      ],
    });
    await waitForSolid(() =>
      expect(
        control.renderProps({ agent, agentId: "main", context: state.context, sending: false })
          .modelCatalog,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ id: "extra" })])),
    );
    expect(container.querySelector("[data-chat-model-search]")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Fixture CLI");
    expect(target()?.hidden).toBe(false);
    input.value = "";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await waitForSolid(() =>
      expect(container.querySelector('[data-chat-model-option="example/extra"]')).not.toBeNull(),
    );
  } finally {
    control.reset();
  }
});

it("retains accepted rows and search through failed refresh, then retires them on a new scope", async () => {
  const initial = { models: [{ provider: "example", id: "current", name: "Current model" }] };
  const state = contextWith(initial.models);
  const agent = { id: "main", model: { primary: "example/current" } };
  Object.assign(state.context.sessions.state.result!.defaults, {
    model: "example/current",
    modelProvider: "example",
  });
  const refresh = deferred<ModelCatalogResult>();
  state.request.mockResolvedValueOnce(initial).mockImplementation(() => refresh.promise);
  const control = new NewSessionModelControl(() => undefined);
  control.load(state.context, "main", true, { agent });
  const container = renderControl(control, state.context, "main", agent);
  try {
    const current = () =>
      container.querySelector<HTMLButtonElement>('[data-chat-model-option="example/current"]');
    await waitForSolid(() => expect(current()).not.toBeNull());
    const input = await focusModelSearch(container);
    const row = current();
    input.value = "current";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flush();
    state.emitCatalogChanged();
    await waitForSolid(() => expect(state.request).toHaveBeenCalledTimes(2));
    expect(container.querySelector("[data-chat-model-refresh]")).toBeNull();
    expect(current()).toBe(row);
    expect(container.querySelector("[data-chat-model-search]")).toBe(input);
    refresh.reject(new Error("Fixture metadata unavailable"));
    await waitForSolid(() =>
      expect(container.textContent).toContain("Some models could not be refreshed"),
    );
    expect(current()).toBe(row);
    expect(input.value).toBe("current");
    expect(document.activeElement).toBe(input);
    const retry = deferred<ModelCatalogResult>();
    state.request.mockImplementation(() => retry.promise);
    state.emitCatalogChanged();
    await waitForSolid(() =>
      expect(container.querySelector("[data-chat-model-refresh]")).not.toBeNull(),
    );
    retry.resolve(initial);
    await waitForSolid(() => {
      expect(container.textContent).not.toContain("Some models could not be refreshed");
      expect(container.querySelector("[data-chat-model-refresh]")).toBeNull();
    });
    expect(current()).toBe(row);
    expect(container.querySelector("[data-chat-model-search]")).toBe(input);
    expect(document.activeElement).toBe(input);
    const next = deferred<ModelCatalogResult>();
    state.request.mockImplementation(() => next.promise);
    const otherAgent = { id: "other", model: { primary: "example/next" } };
    control.load(state.context, "other", true, { agent: otherAgent });
    renderControl(control, state.context, "other", otherAgent);
    flush();
    expect(current()).toBeNull();
    next.resolve({ models: [{ provider: "example", id: "next", name: "Next model" }] });
    await waitForSolid(() =>
      expect(container.querySelector('[data-chat-model-option="example/next"]')).not.toBeNull(),
    );
    expect(current()).toBeNull();
  } finally {
    control.reset();
  }
});
