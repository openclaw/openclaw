import { createSignal, flush, untrack } from "solid-js";
import { expect, it, vi } from "vitest";
import { invalidateModelCatalogCache } from "../../lib/model-catalog-cache.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { NewSessionModelControlView } from "./model-control-view.tsx";
import { contextWith } from "./model-control.test-support.ts";
import { NewSessionModelControl, type NewSessionModelRenderOptions } from "./model-control.ts";

it("keeps one mounted model view live without depending on draft revisions", async () => {
  const model = { id: "gpt-5.5", name: "GPT 5.5", provider: "openai", reasoning: true };
  const models = [model, { ...model, id: "fixture-alternative", name: "Alternative" }];
  const first = contextWith(models);
  const second = contextWith(models);
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
    mountedTrigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flush();
    await waitForSolid(() => expect(option()).not.toBeNull());
    const mountedOption = option();
    expect(mountedOption).not.toBeNull();
    render.mockClear();
    const labels = vi.spyOn(String.prototype, "toLocaleLowerCase");
    try {
      const result = first.context.sessions.state.result!;
      result.sessions.push({
        key: "agent:main:unrelated",
        kind: "direct",
        label: "Background session",
      });
      first.publish("sessions");
      invalidateModelCatalogCache(first.context.gateway.snapshot.client!, {
        agentId: "main",
        sessionKey: "agent:main:unrelated",
      });
      flush();
      expect(render).not.toHaveBeenCalled();
      expect(labels.mock.contexts.filter((value) => String(value) === "GPT 5.5")).toHaveLength(0);
      expect(trigger()).toBe(mountedTrigger);
      expect(option()).toBe(mountedOption);

      // A default can change in place: filtering row traffic must not freeze it.
      agent.model.primary = "";
      first.publish("agents");
      flush();
      result.defaults.model = "fixture-alternative";
      first.publish("sessions");
      flush();
      expect(trigger()?.textContent).toContain("Alternative");
      render.mockClear();
      first.context.sessions.state.result = { ...result, defaults: { ...result.defaults } };
      first.publish("sessions");
      flush();
      expect(render).not.toHaveBeenCalled();
    } finally {
      labels.mockRestore();
    }
    invalidateModelCatalogCache(first.context.gateway.snapshot.client!, { agentId: "main" });
    flush();
    expect(render).toHaveBeenCalled();
    render.mockClear();
    for (const sending of [true, false]) {
      setOptions((previous) => ({ ...previous, sending }));
      await waitForFast(() =>
        expect(render).toHaveBeenLastCalledWith(expect.objectContaining({ sending })),
      );
    }
    control.selectModel("openai/fixture-alternative");
    await waitForFast(() =>
      expect(trigger()?.getAttribute("data-chat-select-value")).toBe("openai/fixture-alternative"),
    );
    const current = control.renderProps(untrack(options));
    current.onThinkingSelect?.("high", current.sessionKey);
    await waitForFast(() =>
      expect(query("[data-chat-thinking-select]")?.getAttribute("data-chat-thinking-value")).toBe(
        "high",
      ),
    );
    first.context.gateway.snapshot.phase = "offline";
    first.publish("gateway");
    await waitForFast(() => expect(trigger()?.getAttribute("aria-disabled")).toBe("true"));
    first.context.gateway.snapshot.phase = "connected";
    first.publish("gateway");
    await waitForFast(() => expect(trigger()?.getAttribute("aria-disabled")).toBe("false"));
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
