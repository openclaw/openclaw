/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { discoveryModuleGate } from "./discovery-controller.test-support.ts";
import { createModelProviderDiscovery } from "./discovery-controller.tsx";

// A redirect supports overlapping imports; an async mock factory bypasses its mock on reentry.
vi.mock("../model-setup/model-setup-page.tsx");

it("retires a cancelled lazy setup and opens the current agent with live presentation data", async () => {
  onTestFinished(() => discoveryModuleGate.resolve());
  let agentId = "first";
  const client = createTestGatewayClient(async () => ({}));
  const onClose = vi.fn();
  const onError = vi.fn();
  let discovery!: ReturnType<typeof createModelProviderDiscovery>;
  let updateLabel!: (label: string) => void;
  const view = mountSolid(() => {
    const [label, setLabel] = createSignal("First agent");
    updateLabel = setLabel;
    discovery = createModelProviderDiscovery({
      canOpen: () => true,
      getOwner: () => ({ client, agentId }),
      onClose,
      onError,
    });
    return discovery.render(() => ({ agentLabel: label(), credentialChoices: [] }));
  });

  discovery.open();
  await waitForSolid(() => expect(view.container.querySelector('[role="status"]')).not.toBeNull());
  discovery.cancelLoading();
  // A replacement can open before the cancelled view commits its removal.
  agentId = "second";
  updateLabel("Second agent");
  discovery.open();
  discoveryModuleGate.resolve();
  await vi.dynamicImportSettled();
  expect(
    onError.mock.calls.map(([error]) => (error instanceof Error ? error.stack : error)),
  ).toEqual([]);
  await waitForSolid(() =>
    expect(view.container.querySelector("[data-setup]")?.textContent).toBe("Second agent"),
  );
  // Once the module is mounted, reconnect belongs to setup rather than its launcher.
  discovery.cancelLoading();
  updateLabel("Renamed agent");
  flush();
  expect(view.container.querySelector("[data-setup]")?.textContent).toBe("Renamed agent");
  view.container.querySelector<HTMLButtonElement>("[data-setup]")!.click();
  flush();
  expect(onClose).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  expect(view.container.textContent).toBe("");
});
