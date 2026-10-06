import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { contextWith, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";

const models = ["default-model", "other-model"].map((id) => ({
  id,
  name: id,
  provider: "openai",
  reasoning: true,
  supportsFastMode: true,
}));
const agent = { id: "main", model: { primary: "openai/default-model" }, thinkingDefault: "high" };
const preference = { model: "openai/other-model", thinkingLevel: "low", fastMode: true };
function setup() {
  const state = contextWith(models);
  Object.assign(state.context, { config: { current: { newSessionModelDefaults: "configured" } } });
  return state;
}

describe("configured fresh-session model defaults", () => {
  it.each(["picker", "url"] as const)(
    "preserves %s intent until the next draft or agent",
    async (source) => {
      const { context, emitCatalogChanged } = setup();
      const control = new NewSessionModelControl(() => undefined);
      control.load(context, "main", true, {
        agent,
        preference,
        ...(source === "url" ? { initialModel: preference.model } : {}),
      });
      await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
      if (source === "picker") {
        renderControl(control, context, "main", agent)
          .querySelector<HTMLButtonElement>('[data-chat-model-option="openai/other-model"]')!
          .click();
      }
      expect(control.selected).toBe(preference.model);
      expect(control.modelForSubmission()).toBe(preference.model);
      control.load(context, "main", true, { agent, preference });
      if (source === "picker") {
        emitCatalogChanged();
      }
      await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
      expect(control.selected).toBe(preference.model);
      if (source === "url") {
        control.load(context, "other", true, { agent: { ...agent, id: "other" }, preference });
      } else {
        control.reset();
        control.load(context, "main", true, { agent, preference });
      }
      await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
      expect(control.selected).toBe("");
      control.reset();
    },
  );

  it.each(["metadata failure", "pending config"] as const)(
    "withholds stale preferences during %s",
    async (pending) => {
      const { context, request } = setup();
      if (pending === "metadata failure") {
        request.mockRejectedValue(new Error("offline"));
      } else {
        Object.assign(context.config.current, { newSessionModelDefaults: null });
      }
      const persist = vi.fn();
      const control = new NewSessionModelControl(() => undefined, persist);
      control.load(context, "main", true, {
        agent,
        preference: { ...preference, agentRuntime: "stale-runtime" },
      });
      await waitForFast(() => expect(control.isRestoringPreference()).toBe(false));
      expect(control).toMatchObject({ selected: "", agentRuntime: undefined, thinkingLevel: "" });
      if (pending === "pending config") {
        expect(persist).not.toHaveBeenCalled();
        Object.assign(context.config.current, { newSessionModelDefaults: "last-used" });
        control.load(context, "main", true, { agent, preference });
        expect(control.selected).toBe(preference.model);
      }
      control.reset();
    },
  );

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
        .querySelector<HTMLButtonElement>('[data-chat-speed-option="off"]')!
        .click();
      expect(control.fastMode).toBe(false);
      control.load(context, "main", true, { agent, preference });
      expect(control.fastMode).toBe(false);
      control.reset();
    },
  );

  it("retires a consumed restored choice but preserves a newer deliberate choice", async () => {
    const { context } = setup();
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
