/* @vitest-environment jsdom */

import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { showInputDialog } from "../../components/input-dialog.tsx";
import { t } from "../../i18n/index.ts";
import { createInitialDevicesState } from "../../lib/nodes/page-operations.ts";
import { createDevicesDialogs, type DevicesDialogHost } from "./devices-dialogs.ts";

vi.mock("../../components/input-dialog.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/input-dialog.tsx")>()),
  showInputDialog: vi.fn(),
}));

function createHost(request = vi.fn(), canManagePairing = () => true): DevicesDialogHost {
  const state = createInitialDevicesState({
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
  });
  return {
    canManagePairing,
    gatewayConnected: () => true,
    gatewayClient: () => null,
    gatewayUrl: () => "http://gateway.test",
    runPageTask: async (task) => task(state),
    runInventoryTask: async (task) => {
      await task(state);
    },
    rotateDevice: vi.fn(),
    setDevicesError: vi.fn(),
  };
}

async function openAlias(
  host = createHost(),
  device: Parameters<ReturnType<typeof createDevicesDialogs>["editAlias"]>[0] = {
    id: "device-1",
    name: "Browser",
  },
) {
  const controller = createDevicesDialogs(host);
  const pending = controller.editAlias(device);
  await vi.waitFor(() => expect(showInputDialog).toHaveBeenCalledOnce());
  const call = vi.mocked(showInputDialog).mock.calls[0];
  assert(call, "Expected alias dialog");
  const [options] = call;
  if (!options.submit) {
    throw new Error("Expected alias dialog submit");
  }
  return { controller, pending, options, submit: options.submit };
}

beforeEach(() => {
  vi.mocked(showInputDialog).mockReset().mockResolvedValue(null);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Devices dialogs editAlias", () => {
  it("renames a paired device through the input dialog", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "device.pair.rename") {
        return { deviceId: (params as { deviceId: string }).deviceId };
      }
      return { paired: [], pending: [] };
    });
    const { pending, options, submit } = await openAlias(createHost(request), {
      id: "device-1",
      name: "Office node",
      operatorLabel: "Old alias",
    });
    expect(options).toMatchObject({
      title: t("devices.inventory.renameTitle", { name: "Office node" }),
      label: t("devices.inventory.renamePrompt"),
      defaultValue: "Old alias",
      requireValue: true,
      requireChange: true,
    });
    expect(await submit("New alias")).toBeNull();
    expect(request).toHaveBeenCalledWith("device.pair.rename", {
      deviceId: "device-1",
      label: "New alias",
    });
    expect(request).toHaveBeenCalledWith("device.pair.list", {});
    await pending;
  });

  it("aborts an open alias dialog when its slot is cancelled", async () => {
    vi.mocked(showInputDialog).mockImplementation(async (options) => {
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return null;
    });

    const { controller, pending, options } = await openAlias();
    controller.cancel();
    await pending;

    expect(options.signal?.aborted).toBe(true);
  });

  it("refuses a rename submitted after pairing access was lost", async () => {
    const request = vi.fn().mockResolvedValue({});
    let canManagePairing = true;
    const { pending, submit } = await openAlias(createHost(request, () => canManagePairing));
    canManagePairing = false;
    expect(await submit("New name")).toContain("operator.pairing");
    expect(request).not.toHaveBeenCalled();
    await pending;
  });
});
