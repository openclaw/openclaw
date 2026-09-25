import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { contextWith, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";

const models = [
  {
    id: "default-model",
    name: "Configured model",
    provider: "openai",
    reasoning: true,
    supportsFastMode: true,
  },
  {
    id: "other-model",
    name: "Other model",
    provider: "openai",
    reasoning: true,
    supportsFastMode: true,
  },
];
const agent = { id: "main", model: { primary: "openai/default-model" }, thinkingDefault: "high" };
const preference = { model: "openai/other-model", thinkingLevel: "low", fastMode: true };

function setup() {
  const state = contextWith(models);
  Object.assign(state.context, { config: { current: { newSessionModelDefaults: "configured" } } });
  return state;
}

describe("configured fresh-session model defaults", () => {
  it("ignores remembered model, runtime and thinking without deleting preferences or Fast Mode", async () => {
    const { context } = setup();
    const persist = vi.fn();
    const control = new NewSessionModelControl(() => undefined, persist);
    control.load(context, "main", true, { agent, preference });
    await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
    expect(control.selected).toBe("");
    expect(control.agentRuntime).toBeUndefined();
    expect(control.thinkingLevel).toBe("");
    expect(control.fastMode).toBe(true);
    expect(renderControl(control, context, "main", agent).textContent).toContain(
      "Configured model",
    );
    expect(persist).not.toHaveBeenCalled();
    expect(preference.thinkingLevel).toBe("low");
    control.reset();
  });

  it("preserves the default remembered behavior when the option is absent", async () => {
    const { context } = contextWith(models);
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true, { agent, preference });
    await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
    expect(control.selected).toBe(preference.model);
    expect(control.thinkingLevel).toBe("low");
    control.reset();
  });

  it("preserves a deliberate model choice across repeated loads and returns to defaults for the next draft", async () => {
    const { context, emitCatalogChanged } = setup();
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true, { agent, preference });
    await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
    renderControl(control, context, "main", agent)
      .querySelector<HTMLButtonElement>('[data-chat-model-option="openai/other-model"]')!
      .click();
    expect(control.selected).toBe(preference.model);
    control.load(context, "main", true, { agent, preference });
    emitCatalogChanged();
    await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
    expect(control.selected).toBe(preference.model);
    control.reset();
    control.load(context, "main", true, { agent, preference });
    await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
    expect(control.selected).toBe("");
    control.reset();
  });

  it("honors explicit URL intent instead of remembered or configured model selection", async () => {
    const { context } = setup();
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true, { agent, preference, initialModel: "openai/other-model" });
    await waitForFast(() => expect(control.modelForSubmission()).toBe("openai/other-model"));
    control.load(context, "main", true, { agent, preference });
    expect(control.selected).toBe("openai/other-model");
    control.reset();
  });

  it("does not restore stale selections when metadata fails", async () => {
    const { context, request } = setup();
    request.mockRejectedValue(new Error("offline"));
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true, {
      agent,
      preference: { ...preference, agentRuntime: "stale-runtime" },
    });
    await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
    expect(control.selected).toBe("");
    expect(control.agentRuntime).toBeUndefined();
    expect(control.thinkingLevel).toBe("");
    control.reset();
  });

  it("seeds another agent independently of a deliberate selection", async () => {
    const { context } = setup();
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true, { agent, initialModel: "openai/other-model" });
    await waitForFast(() => expect(control.selected).toBe("openai/other-model"));
    control.load(context, "other", true, { agent: { ...agent, id: "other" }, preference });
    await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
    expect(control.selected).toBe("");
    control.reset();
  });

  it("restores a deliberate same-route draft choice after agent/config hydration", async () => {
    const { context } = setup();
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
    });
    await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
    expect(control.selected).toBe("openai/other-model");
    expect(control.thinkingLevel).toBe("low");
    expect(control.draftSelection("main")).toMatchObject({
      model: "openai/other-model",
      thinkingLevel: "low",
    });
    control.reset();
  });

  it("waits for UI configuration before admitting a remembered choice", async () => {
    const { context } = contextWith(models);
    Object.assign(context, { config: { current: { newSessionModelDefaults: null } } });
    const persist = vi.fn();
    const control = new NewSessionModelControl(() => undefined, persist);
    control.load(context, "main", true, { agent, preference });
    await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
    expect(control.selected).toBe("");
    expect(persist).not.toHaveBeenCalled();
    Object.assign(context.config.current, { newSessionModelDefaults: "last-used" });
    control.load(context, "main", true, { agent, preference });
    expect(control.selected).toBe(preference.model);
    control.reset();
  });

  it("retires a consumed restored choice but preserves a newer deliberate choice", async () => {
    const { context } = setup();
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true, { agent, preference });
    await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
    const saved = { agentId: "main", model: "openai/other-model", thinkingLevel: "low" };
    control.restoreDraftSelection(saved);
    expect(control.selected).toBe(saved.model);
    control.restoreDraftSelection(undefined);
    expect(control.selected).toBe("");
    expect(control.thinkingLevel).toBe("");
    expect(control.agentRuntime).toBeUndefined();
    expect(control.fastMode).toBe(true);
    expect(control.draftSelection("main")).toBeUndefined();
    control.restoreDraftSelection(saved);
    renderControl(control, context, "main", agent)
      .querySelector<HTMLButtonElement>('[data-chat-model-option="openai/default-model"]')!
      .click();
    control.restoreDraftSelection(undefined);
    expect(control.draftSelection("main")).toMatchObject({ model: "", thinkingLevel: "low" });
    control.reset();
  });

  it.each([false, true])(
    "hydrates Fast Mode independently of a restored model (late preferences: %s)",
    async (late) => {
      const { context, request } = setup();
      const catalog = createDeferred<{ models: typeof models }>();
      request.mockReturnValue(catalog.promise);
      const control = new NewSessionModelControl(() => undefined);
      control.load(context, "main", true, { agent, preference: late ? null : preference });
      control.restoreDraftSelection({
        agentId: "main",
        model: "openai/other-model",
        thinkingLevel: "low",
      });
      control.load(context, "main", true, { agent, preference });
      catalog.resolve({ models });
      await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
      expect(control.fastMode).toBe(true);
      renderControl(control, context, "main", agent)
        .querySelector<HTMLButtonElement>("[data-chat-speed-toggle]")!
        .click();
      expect(control.fastMode).toBe(false);
      control.load(context, "main", true, { agent, preference });
      expect(control.fastMode).toBe(false);
      control.reset();
    },
  );
});
