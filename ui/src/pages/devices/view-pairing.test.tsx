/* @vitest-environment jsdom */
import { createComponent, createSignal, flush } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  closeDevicePairSetup,
  createDevicePairSetupState,
  readDevicePairSetupSnapshot,
  refreshDevicePairSetup,
  type DevicePairSetupLifecycle,
} from "../../lib/device-pair-setup.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { DevicePairSetup } from "./view-pairing.tsx";

function renderPairing(lifecycle: DevicePairSetupLifecycle, nowMs = 0) {
  return mountSolid(() =>
    createComponent(DevicePairSetup, {
      open: true,
      lifecycle,
      nowMs,
      pendingCount: 0,
      onRefresh: vi.fn(async () => {}),
      onAccessChange: vi.fn(),
      onClose: vi.fn(),
      onManageDevices: vi.fn(),
      onGetApps: vi.fn(),
    }),
  ).container;
}

function renderOwnedPairing(
  request: Parameters<typeof createTestGatewayClient>[0],
  lifecycle: DevicePairSetupLifecycle = { phase: "selection", access: "full" },
) {
  const state = createDevicePairSetupState({
    client: createTestGatewayClient(request),
    connected: true,
  });
  state.devicePairSetupOpen = true;
  state.devicePairSetupLifecycle = lifecycle;
  let publish = () => {};
  const operations: Promise<void>[] = [];
  const mounted = mountSolid(() => {
    const [snapshot, setSnapshot] = createSignal(readDevicePairSetupSnapshot(state));
    publish = () => setSnapshot(readDevicePairSetupSnapshot(state));
    state.onDevicePairSetupChange = publish;
    return (
      <DevicePairSetup
        open={snapshot().devicePairSetupOpen}
        lifecycle={snapshot().devicePairSetupLifecycle}
        nowMs={0}
        pendingCount={0}
        onRefresh={async () => {
          const operation = refreshDevicePairSetup(state);
          operations.push(operation);
          publish();
          await operation;
          publish();
        }}
        onAccessChange={vi.fn()}
        onClose={() => {
          closeDevicePairSetup(state);
          publish();
        }}
        onManageDevices={vi.fn()}
        onGetApps={vi.fn()}
      />
    );
  });
  onTestFinished(() => closeDevicePairSetup(state));
  return { ...mounted, state, publish, operations };
}

describe("device pairing dialog", () => {
  it("shows status Retry pending and retires it on close before a late completion", async () => {
    const status = createDeferred<{
      completion: { setupId: string; access: "full"; deviceName: string };
    }>();
    const request = vi.fn<Parameters<typeof createTestGatewayClient>[0]>(() => status.promise);
    const view = renderOwnedPairing(request, {
      phase: "error",
      source: "status",
      access: "full",
      setupId: "old-setup",
      message: "Offline",
    });
    view.getByRole("button", { name: "Reload" }).click();
    await waitForSolid(() => {
      expect(view.container.querySelector(".device-pair-setup__loading")).not.toBeNull();
      expect(view.queryByRole("alert")).toBeNull();
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]).toEqual(["device.pair.setupStatus", { setupId: "old-setup" }]);

    view.getByRole("button", { name: "Dismiss" }).click();
    await waitForSolid(() => expect(view.container.querySelector(".device-pair-setup")).toBeNull());
    view.state.devicePairSetupOpen = true;
    view.publish();
    await waitForSolid(() =>
      expect(view.getByRole("button", { name: "Create setup code" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    status.resolve({
      completion: { setupId: "old-setup", access: "full", deviceName: "Retired phone" },
    });
    await Promise.all(view.operations);
    await waitForSolid(() => {
      expect(view.getByRole("button", { name: "Create setup code" }).hasAttribute("disabled")).toBe(
        false,
      );
      expect(view.queryByText("Retired phone")).toBeNull();
    });
  });

  it("keeps create failures visible and allows a successful retry", async () => {
    const first = createDeferred<never>();
    const second = createDeferred<unknown>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = renderOwnedPairing(request);
    view.getByRole("button", { name: "Create setup code" }).click();
    await waitForSolid(() =>
      expect(view.container.querySelector(".device-pair-setup__loading")).not.toBeNull(),
    );
    first.reject(new Error("Synthetic create failure"));
    await waitForSolid(() =>
      expect(view.getByRole("alert").textContent).toContain("Synthetic create failure"),
    );
    view.getByRole("button", { name: "Reload" }).click();
    await waitForSolid(() =>
      expect(view.container.querySelector(".device-pair-setup__loading")).not.toBeNull(),
    );
    second.resolve({
      setupId: "new-setup",
      setupCode: "SYNTHETIC",
      expiresAtMs: Date.now() + 60000,
      gatewayUrl: "wss://gateway.example.test",
      auth: "token",
      urlSource: "test",
    });
    await waitForSolid(() =>
      expect(view.getByRole("button", { name: "New code" }).hasAttribute("disabled")).toBe(false),
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(view.queryByRole("alert")).toBeNull();
  });

  it.each([
    { lifecycle: { phase: "selection", access: "full" }, choices: true, selectable: true },
    {
      lifecycle: { phase: "error", source: "create", access: "full", message: "Try again" },
      choices: true,
      selectable: true,
    },
    { lifecycle: { phase: "expired", access: "full" }, choices: true, selectable: false },
    {
      lifecycle: {
        phase: "error",
        source: "status",
        access: "full",
        setupId: "test",
        message: "Try again",
      },
      choices: false,
      selectable: false,
    },
    { lifecycle: { phase: "success", access: "full" }, choices: false, selectable: false },
    {
      lifecycle: { phase: "delivery-uncertain", access: "full" },
      choices: false,
      selectable: false,
    },
  ] satisfies { lifecycle: DevicePairSetupLifecycle; choices: boolean; selectable: boolean }[])(
    "keeps access choices within the $lifecycle.phase lifecycle",
    ({ lifecycle, choices, selectable }) => {
      const container = renderPairing(lifecycle);
      const fieldset = container.querySelector("fieldset");
      expect(Boolean(fieldset)).toBe(choices);
      if (fieldset) {
        expect(fieldset.disabled).toBe(!selectable);
      }
    },
  );

  it.each([
    {
      access: "full" as const,
      href: "https://docs.openclaw.ai/channels/pairing#pair-from-the-control-ui-recommended",
    },
    {
      access: "node" as const,
      href: "https://docs.openclaw.ai/gateway/pairing#one-paste-node-pairing",
    },
  ])("links $access setup help to the matching workflow", ({ access, href }) => {
    const container = renderPairing({ phase: "selection", access });

    expect(container.textContent).toContain(
      "Device capabilities plus complete Gateway controls, including settings and upgrades.",
    );
    expect(container.textContent).toContain("Connect a computer as a command and capability host.");
    expect(container.querySelector<HTMLAnchorElement>(".device-pair-setup__footer a")?.href).toBe(
      href,
    );
  });

  it("renders the node one-paste command and quiet expiry countdown", () => {
    const container = renderPairing(
      {
        phase: "waiting",
        access: "node",
        setup: {
          setupId: "setup-node",
          setupCode: "AbC_123",
          gatewayUrl: "wss://gateway.example",
          auth: "token",
          urlSource: "test",
          access: "node",
          expiresAtMs: 70_000,
        },
      },
      10_000,
    );

    expect(container.querySelectorAll('input[name="device-pair-access"]')).toHaveLength(3);
    expect(container.querySelector(".device-pair-setup__command code")?.textContent).toBe(
      'openclaw node run --pair "oc-pair://AbC_123"',
    );
    expect(container.querySelector('[role="timer"]')?.textContent?.trim()).toBe(
      "This setup link expires in 1:00.",
    );
  });

  it("announces device requests that arrive while the setup code is shown", () => {
    const [pendingCount, setPendingCount] = createSignal(0);
    const view = mountSolid(() =>
      createComponent(DevicePairSetup, {
        open: true,
        lifecycle: {
          phase: "waiting",
          access: "node",
          setup: {
            setupId: "setup-node",
            setupCode: "AbC_123",
            gatewayUrl: "wss://gateway.example",
            auth: "token",
            urlSource: "test",
            access: "node",
            expiresAtMs: 70_000,
          },
        },
        nowMs: 10_000,
        get pendingCount() {
          return pendingCount();
        },
        onRefresh: vi.fn(async () => {}),
        onAccessChange: vi.fn(),
        onClose: vi.fn(),
        onManageDevices: vi.fn(),
        onGetApps: vi.fn(),
      }),
    );

    const waiting = "Run the command on the device, then review its pairing request here.";
    const status = view.getByRole("status");
    expect(status.textContent).toBe("");
    view.getByText(waiting);
    setPendingCount(1);
    flush();
    expect(view.getByRole("status")).toBe(status);
    expect(view.queryByText(waiting)).toBeNull();
    expect(status.textContent).toBe("Device requests waiting for review: 1");
    setPendingCount(2);
    flush();
    expect(view.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("Device requests waiting for review: 2");
    setPendingCount(0);
    flush();
    expect(view.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("");
    view.getByText(waiting);
  });
});
