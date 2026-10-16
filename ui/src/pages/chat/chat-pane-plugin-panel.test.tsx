import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiViewContext } from "../../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../../app/context.ts";
import { PRESENTATION_CHANGED_EVENT, type PresentationValue } from "../../lib/presentation.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { EmbeddedPluginPanel } from "./chat-pane-plugin-panel.tsx";
import { readRegionPanelHost } from "./components/chat-sidebar-region-header.tsx";

it("retains the plugin panel while parking and reveals it with current pane props", async () => {
  const owner = new EventTarget();
  let presented = true;
  let preview = false;
  const binding = { owner, isPresented: () => presented, preview: () => preview };
  const [presentation, setPresentation] = createSignal<PresentationValue>(binding);
  const [sessionKey, setSessionKey] = createSignal("agent:main:first");
  const update = vi.fn<(context: ControlUiViewContext<unknown>) => void>();
  const dispose = vi.fn();
  const mount = vi.fn((container: HTMLElement, context: ControlUiViewContext<unknown>) => {
    const input = document.createElement("input");
    input.value = "Panel draft";
    container.append(input);
    update(context);
    return { update, dispose };
  });
  const signal = new AbortController().signal;
  const registration = {
    key: "fixture/notes",
    pluginId: "fixture",
    value: { mount },
    host: { signal, sessions: {}, agents: {}, navigation: {}, ui: {}, components: {} },
    signal,
  };
  // SAFETY: PluginView only reads this registry, lifecycle signal, and error reporter.
  const context = {
    plugins: {
      registrations: () => [registration],
      subscribe: () => () => {},
      reportError: vi.fn(),
    },
  } as unknown as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  const view = mountSolid(
    () => (
      <span style={{ display: "contents" }}>
        <EmbeddedPluginPanel
          contributionKey="fixture/notes"
          props={{ sessionKey: sessionKey(), agentId: "main" }}
          presentation={presentation()}
        />
      </span>
    ),
    { wrapper: provider.wrapper },
  );
  await waitForSolid(() => expect(mount).toHaveBeenCalledOnce());
  const region = document.createElement("div");
  view.container.after(region);
  view.container.dataset.panelSlot = "plugin:fixture/notes";
  onTestFinished(() => region.remove());
  expect(readRegionPanelHost(region, "plugin:fixture/notes")).toBe(
    view.container.querySelector("openclaw-plugin-view"),
  );
  const input = view.container.querySelector("input");
  presented = false;
  owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
  await waitForSolid(() => expect(update.mock.lastCall?.[0].presented).toBe(false));
  expect(view.container.querySelector("input")).toBe(input);

  presented = true;
  owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
  expect(update.mock.lastCall?.[0].presented).toBe(false);
  setPresentation({ ...binding });
  await waitForSolid(() => expect(update.mock.lastCall?.[0].presented).toBe(true));
  expect(view.container.querySelector("input")).toBe(input);
  expect(input?.value).toBe("Panel draft");

  presented = false;
  owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
  await waitForSolid(() => expect(update.mock.lastCall?.[0].presented).toBe(false));
  presented = true;
  preview = true;
  owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
  await waitForSolid(() => expect(update.mock.lastCall?.[0].presented).toBe(true));

  setSessionKey("agent:main:second");
  await waitForSolid(() => expect(mount).toHaveBeenCalledTimes(2));
  expect(update.mock.lastCall?.[0].props).toEqual({
    sessionKey: "agent:main:second",
    agentId: "main",
  });
  expect(dispose).toHaveBeenCalledOnce();
  view.unmount();
  expect(dispose).toHaveBeenCalledTimes(2);
});
