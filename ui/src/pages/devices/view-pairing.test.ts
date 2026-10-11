/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DevicePairSetupLifecycle } from "../../lib/device-pair-setup.ts";
import { renderDevicePairSetup } from "./view-pairing.runtime.ts";

const containers: HTMLElement[] = [];
function createContainer() {
  const container = document.body.appendChild(document.createElement("div"));
  containers.push(container);
  return container;
}
afterEach(() => {
  for (const container of containers.splice(0)) {
    render(nothing, container);
    container.remove();
  }
});

describe("device pairing dialog", () => {
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
      const container = createContainer();
      render(
        renderDevicePairSetup({
          open: true,
          lifecycle,
          nowMs: 0,
          pendingCount: 0,
          onRefresh: vi.fn(),
          onAccessChange: vi.fn(),
          onClose: vi.fn(),
          onManageDevices: vi.fn(),
          onGetApps: vi.fn(),
        }),
        container,
      );
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
    const container = createContainer();

    render(
      renderDevicePairSetup({
        open: true,
        lifecycle: { phase: "selection", access },
        nowMs: 0,
        pendingCount: 0,
        onRefresh: vi.fn(),
        onAccessChange: vi.fn(),
        onClose: vi.fn(),
        onManageDevices: vi.fn(),
        onGetApps: vi.fn(),
      }),
      container,
    );

    expect(container.textContent).toContain(
      "Device capabilities plus complete Gateway controls, including settings and upgrades.",
    );
    expect(container.textContent).toContain("Connect a computer as a command and capability host.");
    expect(container.querySelector<HTMLAnchorElement>(".device-pair-setup__footer a")?.href).toBe(
      href,
    );
  });

  it("renders the node one-paste command and quiet expiry countdown", () => {
    const container = createContainer();

    render(
      renderDevicePairSetup({
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
        pendingCount: 0,
        onRefresh: vi.fn(),
        onAccessChange: vi.fn(),
        onClose: vi.fn(),
        onManageDevices: vi.fn(),
        onGetApps: vi.fn(),
      }),
      container,
    );

    expect(container.querySelectorAll('input[name="device-pair-access"]')).toHaveLength(3);
    expect(container.querySelector(".device-pair-setup__command code")?.textContent).toBe(
      'openclaw node run --pair "oc-pair://AbC_123"',
    );
    expect(container.querySelector('[role="timer"]')?.textContent?.trim()).toBe(
      "This setup link expires in 1:00.",
    );
  });
});
