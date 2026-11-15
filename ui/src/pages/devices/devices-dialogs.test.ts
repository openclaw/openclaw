/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { showInputDialog } from "../../components/input-dialog.tsx";
import { t } from "../../i18n/index.ts";
import { createInitialDevicesState } from "../../lib/nodes/page-operations.ts";
import { createDevicesDialogs, type DevicesDialogHost } from "./devices-dialogs.ts";

vi.mock("../../components/confirm-dialog.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/confirm-dialog.ts")>()),
  showConfirmDialog: vi.fn(),
}));

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

beforeEach(() => {
  vi.mocked(showInputDialog).mockReset().mockResolvedValue(null);
  vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(false);
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
    expect(await submit("New name")).toContain("only admins");
    expect(request).not.toHaveBeenCalled();
    await pending;
  });
});

describe("Devices destructive confirmation recovery", () => {
  it("returns false after failed discard preparation and releases the shared slot", async () => {
    const host = createHost();
    const dialogs = createDevicesDialogs(host);
    vi.mocked(showConfirmDialog).mockRejectedValueOnce(new Error("Discard dialog could not load"));

    await expect(dialogs.confirmExecApprovalsDiscard()).resolves.toBe(false);
    expect(host.setDevicesError).toHaveBeenCalledWith("Discard dialog could not load");
    await dialogs.editAlias({ id: "device-1", name: "Office node" });
    expect(showInputDialog).toHaveBeenCalledOnce();

    await expect(dialogs.confirmExecApprovalsDiscard()).resolves.toBe(false);
    vi.mocked(showConfirmDialog).mockResolvedValueOnce(true);
    await expect(dialogs.confirmExecApprovalsDiscard()).resolves.toBe(true);
    expect(showConfirmDialog).toHaveBeenCalledTimes(3);
  });

  it("reports failed preparation, releases the slot, and requires confirmation on retry", async () => {
    const request = vi.fn().mockResolvedValue({ pending: [], paired: [] });
    const host = createHost(request);
    const dialogs = createDevicesDialogs(host);
    vi.mocked(showConfirmDialog).mockRejectedValueOnce(new Error("Dialog could not load"));

    await expect(dialogs.confirmPairingReject("device", "request-1")).resolves.toBeUndefined();
    expect(host.setDevicesError).toHaveBeenCalledWith("Dialog could not load");
    expect(request).not.toHaveBeenCalled();

    await dialogs.editAlias({ id: "device-1", name: "Office node" });
    expect(showInputDialog).toHaveBeenCalledOnce();
    await dialogs.confirmPairingReject("device", "request-1");
    expect(request).not.toHaveBeenCalled();

    vi.mocked(showConfirmDialog).mockResolvedValueOnce(true);
    await dialogs.confirmPairingReject("device", "request-1");
    expect(request).toHaveBeenCalledWith("device.pair.reject", { requestId: "request-1" });
    expect(showConfirmDialog).toHaveBeenCalledTimes(3);
  });

  it.each(["device rejection", "policy discard"])(
    "does not publish a cancelled %s preparation failure",
    async (kind) => {
      const preparation = Promise.withResolvers<boolean>();
      vi.mocked(showConfirmDialog).mockReturnValueOnce(preparation.promise);
      const request = vi.fn();
      const host = createHost(request);
      const dialogs = createDevicesDialogs(host);
      const result =
        kind === "device rejection"
          ? dialogs.confirmPairingReject("device", "request-1")
          : dialogs.confirmExecApprovalsDiscard();

      dialogs.cancel();
      preparation.reject(new Error("Retired dialog failed"));
      await result;

      expect(host.setDevicesError).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );
});
