/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { DevicePairSetupLifecycle } from "../../lib/device-pair-setup.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { DevicePairSetup } from "./view-pairing.tsx";

function renderPairing(lifecycle: DevicePairSetupLifecycle, nowMs = 0) {
  return mountSolid(() =>
    createComponent(DevicePairSetup, {
      open: true,
      lifecycle,
      nowMs,
      pendingCount: 0,
      onRefresh: vi.fn(),
      onAccessChange: vi.fn(),
      onClose: vi.fn(),
      onManageDevices: vi.fn(),
      onGetApps: vi.fn(),
    }),
  ).container;
}

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
});
