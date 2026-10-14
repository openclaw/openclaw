import { createSignal, untrack } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
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
  const render = vi.spyOn(control, "renderProps");
  try {
    setOptions((previous) => ({ ...previous }));
    await Promise.resolve();
    expect(render).not.toHaveBeenCalled();
    for (const owner of ["gateway", "agents", "sessions", "config"] as const) {
      first.publish(owner);
      await waitForFast(() => expect(render).toHaveBeenCalled());
      render.mockClear();
    }
    const trigger = () => view.container.querySelector("[data-chat-model-select]");
    setOptions((previous) => ({ ...previous, sending: true }));
    await waitForFast(() =>
      expect(render).toHaveBeenLastCalledWith(expect.objectContaining({ sending: true })),
    );
    setOptions((previous) => ({ ...previous, sending: false }));
    await waitForFast(() =>
      expect(render).toHaveBeenLastCalledWith(expect.objectContaining({ sending: false })),
    );
    control.selectModel("openai/fixture-alternative");
    await waitForFast(() =>
      expect(trigger()?.getAttribute("data-chat-select-value")).toBe("openai/fixture-alternative"),
    );
    const current = control.renderProps(untrack(options));
    current.onThinkingSelect?.("high", current.sessionKey);
    await waitForFast(() =>
      expect(
        view.container
          .querySelector("[data-chat-thinking-select]")
          ?.getAttribute("data-chat-thinking-value"),
      ).toBe("high"),
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
