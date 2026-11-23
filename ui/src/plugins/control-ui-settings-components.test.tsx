import { expect, it, onTestFinished } from "vitest";
import { lazyView } from "../../../extensions/lobsterdex/browser/lazy-view.ts";
import { mountMemoryScene } from "../../../extensions/lobsterdex/browser/memory-scene.tsx";
import type { ApplicationContext } from "../app/context.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { accessoryFixture } from "../test-helpers/control-ui-accessory-fixture.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { createControlUiSettingsComponents } from "./control-ui-settings-components.solid.tsx";

it("keeps Memory artwork in the plugin lifetime without replacing its surrounding Settings", async () => {
  const fixture = accessoryFixture([
    {
      id: "memory",
      placement: "memory-scene",
      mount: lazyView(async () => ({ default: mountMemoryScene })),
    },
  ]);
  // SAFETY: this host component consumes only the plugin registry and its lifetime.
  const application = { plugins: fixture.plugins } as ApplicationContext;
  const provider = createApplicationContextProvider(application);
  document.body.append(provider);
  const container = provider.appendChild(document.createElement("div"));
  const abort = new AbortController();
  const view = createControlUiSettingsComponents(abort.signal, application).mountLobster(
    container,
    { seed: "main", sleeping: true },
  );
  onTestFinished(() => {
    view.dispose();
    abort.abort();
    provider.remove();
  });
  await waitForSolid(() => expect(container.querySelector("svg")).not.toBeNull());
  const image = container.querySelector("svg");
  view.update({ seed: "main", reading: true });
  await waitForSolid(() => expect(container.querySelector(".lob-reading-book")).not.toBeNull());
  expect(container.querySelector("svg")).toBe(image);
  fixture.retire();
  await waitForSolid(() => expect(container.querySelector("svg")).toBeNull());
  expect(container.isConnected).toBe(true);
});
