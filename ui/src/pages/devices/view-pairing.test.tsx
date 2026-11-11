/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  closeDevicePairSetup,
  createDevicePairSetupState,
  readDevicePairSetupSnapshot,
  refreshDevicePairSetup,
  type DevicePairSetupLifecycle,
} from "../../lib/device-pair-setup.ts";
import { createWaitingNodePairSetup } from "../../test-helpers/devices-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { DevicePairSetup, type DevicePairSetupProps } from "./view-pairing.tsx";

function Pairing(props: Partial<DevicePairSetupProps> & Pick<DevicePairSetupProps, "lifecycle">) {
  return (
    <DevicePairSetup
      open={true}
      nowMs={0}
      pendingCount={0}
      onRefresh={vi.fn(async () => {})}
      onAccessChange={vi.fn()}
      onClose={vi.fn()}
      onManageDevices={vi.fn()}
      onGetApps={vi.fn()}
      {...props}
    />
  );
}

type PairingView = ReturnType<typeof mountSolid>;
const expectEnabled = (view: PairingView) =>
  expect(view.getByRole("button", { name: "Create setup code" }).hasAttribute("disabled")).toBe(
    false,
  );

describe("device pairing dialog", () => {
  it("shows status Retry pending and retires it on close before a late completion", async () => {
    const status = createDeferred<{
      completion: { setupId: string; access: "full"; deviceName: string };
    }>();
    const state = createDevicePairSetupState({
      client: createTestGatewayClient(() => status.promise),
      connected: true,
    });
    state.devicePairSetupOpen = true;
    state.devicePairSetupLifecycle = {
      phase: "error",
      source: "status",
      access: "full",
      setupId: "old-setup",
      message: "Offline",
    };
    let publish = () => {};
    let operation: Promise<void> | undefined;
    const onRefresh = async () => {
      operation = refreshDevicePairSetup(state);
      publish();
      await operation;
      publish();
    };
    const view = mountSolid(() => {
      const [snapshot, setSnapshot] = createSignal(readDevicePairSetupSnapshot(state));
      publish = () => setSnapshot(readDevicePairSetupSnapshot(state));
      state.onDevicePairSetupChange = publish;
      return (
        <Pairing
          open={snapshot().devicePairSetupOpen}
          lifecycle={snapshot().devicePairSetupLifecycle}
          onRefresh={onRefresh}
          onClose={() => {
            closeDevicePairSetup(state);
            publish();
          }}
        />
      );
    });
    onTestFinished(() => closeDevicePairSetup(state));
    view.getByRole("button", { name: "Reload" }).click();
    await waitForSolid(() => {
      expect(view.container.querySelector(".device-pair-setup__loading")).not.toBeNull();
      expect(view.queryByRole("alert")).toBeNull();
    });

    view.getByRole("button", { name: "Dismiss" }).click();
    await waitForSolid(() => expect(view.container.querySelector(".device-pair-setup")).toBeNull());
    state.devicePairSetupOpen = true;
    publish();
    await waitForSolid(() => expectEnabled(view));
    status.resolve({
      completion: { setupId: "old-setup", access: "full", deviceName: "Retired phone" },
    });
    await operation;
    await waitForSolid(() => {
      expectEnabled(view);
      expect(view.queryByText("Retired phone")).toBeNull();
    });
  });

  it.each([
    { lifecycle: { phase: "selection", access: "full" }, choices: true, selectable: true },
    {
      lifecycle: { phase: "error", source: "create", access: "full", message: "Try again" },
      choices: true,
      selectable: true,
    },
    { lifecycle: { phase: "expired", access: "full" }, choices: false, selectable: false },
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
      const { container } = mountSolid(() => <Pairing lifecycle={lifecycle} />);
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
    const { container } = mountSolid(() => <Pairing lifecycle={{ phase: "selection", access }} />);

    expect(container.textContent).toContain(
      "Use device tools and manage all settings and updates.",
    );
    expect(container.textContent).toContain(
      "Let agents run commands and use tools on this device.",
    );
    expect(container.querySelector<HTMLAnchorElement>(".device-pair-setup__help")?.href).toBe(href);
  });

  it("offers the apps beside the scan step", () => {
    const selection = mountSolid(() => (
      <Pairing lifecycle={{ phase: "selection", access: "full" }} />
    ));
    expect(selection.queryByRole("button", { name: "Get the apps" })).toBeNull();

    const onGetApps = vi.fn();
    const lifecycle = {
      ...createWaitingNodePairSetup(),
      access: "full",
    } as unknown as DevicePairSetupLifecycle;
    const waiting = mountSolid(() => (
      <Pairing lifecycle={lifecycle} nowMs={10_000} onGetApps={onGetApps} />
    ));
    const getApps = waiting.getByRole("button", { name: "Get the apps" });
    expect(getApps.closest(".device-pair-setup__waiting")?.textContent).toBe(
      "Official OpenClaw mobile apps connect automatically after scanning. Get the apps",
    );
    getApps.click();
    expect(onGetApps).toHaveBeenCalledTimes(1);
  });

  it("moves the accent to Review once a device request is waiting", () => {
    let setPendingCount!: (count: number) => void;
    const lifecycle = {
      ...createWaitingNodePairSetup(),
      access: "full",
    } as unknown as DevicePairSetupLifecycle;
    const view = mountSolid(() => {
      const [pendingCount, setCount] = createSignal(0);
      setPendingCount = setCount;
      return <Pairing lifecycle={lifecycle} nowMs={10_000} pendingCount={pendingCount()} />;
    });
    const copy = () => view.getByRole("button", { name: "Copy setup code" });

    expect(copy().classList.contains("primary")).toBe(true);
    expect(view.queryByRole("button", { name: "Review" })).toBeNull();
    view.getByRole("button", { name: "Manage devices" });

    setPendingCount(1);
    flush();

    expect(copy().classList.contains("primary")).toBe(false);
    expect(view.getByRole("button", { name: "Review" }).classList.contains("primary")).toBe(true);
    expect(view.queryByRole("button", { name: "Manage devices" })).toBeNull();
  });

  it("renders node setup instructions and announces arriving device requests", () => {
    let setPendingCount!: (count: number) => void;
    const view = mountSolid(() => {
      const [pendingCount, setCount] = createSignal(0);
      setPendingCount = setCount;
      return (
        <Pairing
          lifecycle={createWaitingNodePairSetup()}
          nowMs={10_000}
          pendingCount={pendingCount()}
        />
      );
    });

    const { container } = view;
    expect(container.querySelectorAll('input[name="device-pair-access"]')).toHaveLength(0);
    expect(container.querySelector(".device-pair-setup__command code")?.textContent).toBe(
      'openclaw node run --pair "oc-pair://AbC_123"',
    );
    expect(container.querySelector('[role="timer"]')?.textContent?.trim()).toBe(
      "This setup link expires in 1:00.",
    );
    expect(container.querySelector<HTMLAnchorElement>(".device-pair-setup__help")?.href).toBe(
      "https://docs.openclaw.ai/gateway/pairing#one-paste-node-pairing",
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
