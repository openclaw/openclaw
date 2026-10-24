import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { AgentConfigButtons, type AgentConfigActions } from "./config-actions.tsx";

function controls(overrides: Partial<AgentConfigActions> = {}) {
  const props: AgentConfigActions = {
    configLoading: false,
    configSaving: false,
    configDirty: true,
    canUpdateConfig: true,
    presentationRetired: createDeferred().promise,
    onConfigSave: async () => undefined,
    onConfigReload: async () => undefined,
    ...overrides,
  };
  const mounted = mountSolid(AgentConfigButtons, props);
  const [reload, save] = mounted.container.querySelectorAll("button");
  return { ...mounted, props, reload: reload!, save: save! };
}

it.each(["save", "reload"] as const)(
  "keeps both controls disabled through a held %s without owner busy publication",
  async (operation) => {
    const pending = createDeferred<unknown>();
    const invoke = vi.fn(() => pending.promise);
    const view = controls({
      [operation === "save" ? "onConfigSave" : "onConfigReload"]: invoke,
    });
    const button = view[operation];
    button.click();
    expect(invoke).toHaveBeenCalledOnce();
    await waitForSolid(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    expect(view.save.disabled).toBe(true);
    expect(view.reload.disabled).toBe(true);
    if (operation === "save") {
      expect(view.save.textContent).toBe("Saving…");
    }
    pending.resolve(false);
    await waitForSolid(() => expect(view.save.disabled).toBe(false));
    expect(view.reload.disabled).toBe(false);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  },
);

it("shows an unexpected rejection and retries with the current callback", async () => {
  const pending = createDeferred();
  const view = controls({ onConfigSave: () => pending.promise });
  view.save.click();
  await waitForSolid(() => expect(view.save.disabled).toBe(true));
  pending.reject(new Error("Synthetic save unavailable"));
  await waitForSolid(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Synthetic save unavailable",
    ),
  );
  const retry = vi.fn(async () => undefined);
  view.update({ ...view.props, onConfigSave: retry });
  view.save.click();
  await waitForSolid(() => expect(retry).toHaveBeenCalledOnce());
  await waitForSolid(() => expect(view.container.querySelector('[role="alert"]')).toBeNull());
  expect(view.save.disabled).toBe(false);
});

it("retires held feedback and consumes late rejection without poisoning the replacement scope", async () => {
  const pending = createDeferred();
  const lifetime = createDeferred();
  const view = controls({
    presentationRetired: lifetime.promise,
    onConfigReload: () => pending.promise,
  });
  view.reload.click();
  await waitForSolid(() => expect(view.reload.disabled).toBe(true));
  const nextReload = vi.fn(async () => undefined);
  lifetime.resolve();
  view.update({
    ...view.props,
    presentationRetired: createDeferred().promise,
    onConfigReload: nextReload,
  });
  await waitForSolid(() => expect(view.reload.disabled).toBe(false));
  pending.reject(new Error("Retired save unavailable"));
  await pending.promise.catch(() => undefined);
  flush();
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  view.reload.click();
  await waitForSolid(() => expect(nextReload).toHaveBeenCalledOnce());
});

it("lets the owner lock the form after pending writes drain during Reload", async () => {
  const writesDrained = createDeferred();
  const read = createDeferred();
  const retired = createDeferred().promise;
  const view = mountSolid(() => {
    const [loading, setLoading] = createSignal(false);
    const save = async () => undefined;
    const reload = async () => {
      await writesDrained.promise;
      setLoading(true);
      await read.promise;
      setLoading(false);
    };
    return (
      <>
        <input aria-label="Agent setting" disabled={loading()} />
        <AgentConfigButtons
          configLoading={loading()}
          configSaving={false}
          configDirty={true}
          canUpdateConfig={true}
          presentationRetired={retired}
          onConfigSave={save}
          onConfigReload={reload}
        />
      </>
    );
  }, {});
  const reload = view.container.querySelector<HTMLButtonElement>("button")!;
  const field = view.container.querySelector<HTMLInputElement>("input")!;
  try {
    reload.click();
    await waitForSolid(() => expect(reload.disabled).toBe(true));
    expect(field.disabled).toBe(false);
    writesDrained.resolve();
    await waitForSolid(() => expect(field.disabled).toBe(true));
    read.resolve();
    await waitForSolid(() => expect(field.disabled).toBe(false));
    expect(reload.disabled).toBe(false);
  } finally {
    writesDrained.resolve();
    read.resolve();
    view.dispose();
  }
});
