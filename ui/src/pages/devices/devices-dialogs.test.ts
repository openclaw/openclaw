/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

async function openAlias(host: DevicesDialogHost) {
  const pending = createDevicesDialogs(host).editAlias({
    id: "device-1",
    name: "Office node",
    operatorLabel: "Old alias",
  });
  await vi.waitFor(() => expect(showInputDialog).toHaveBeenCalledOnce());
  const [options] = expectDefined(vi.mocked(showInputDialog).mock.calls[0], "alias dialog");
  return { pending, options, submit: expectDefined(options.submit, "alias submit") };
}

beforeEach(() => void vi.mocked(showInputDialog).mockReset().mockResolvedValue(null));

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
    const { pending, options, submit } = await openAlias(createHost(request));
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
