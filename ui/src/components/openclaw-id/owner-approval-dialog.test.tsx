/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { startOpenClawIdFeatureLifetime } from "../../lib/openclaw-id/feature-lifetime.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { showOwnerApprovalDialog } from "./owner-approval-dialog.tsx";
import { showOwnerDevicesDialog } from "./owner-devices-dialog.tsx";

// Dialogs open only while the enabled feature's lifetime runs.
let endFeature = () => {};
beforeEach(() => {
  endFeature = startOpenClawIdFeatureLifetime();
});
afterEach(() => endFeature());

const fixture = vi.hoisted(() => ({
  code: undefined as string | undefined,
  expired: false,
  uncertain: false,
  listeners: new Set<() => void>(),
  decide: vi.fn(),
}));
// mock-isolation: the approval lifetime is driven by the test instead of a live Gateway mailbox.
vi.mock("../../lib/openclaw-id/owner-approval-lifetime.ts", () => ({
  ownerApprovalFor: () => ({
    read: () => ({
      ready: true,
      error: null,
      requests: [
        {
          id: "request",
          label: "Firefox on Linux",
          code: fixture.code,
          busy: fixture.uncertain,
          expired: fixture.expired,
          error: fixture.uncertain
            ? "Request timed out. Check Your devices before starting a new request."
            : fixture.expired
              ? "This device request expired or was cancelled."
              : undefined,
          uncertain: fixture.uncertain,
        },
      ],
    }),
    subscribe: (listener: () => void) => {
      fixture.listeners.add(listener);
      return () => fixture.listeners.delete(listener);
    },
    decide: fixture.decide,
  }),
}));
afterEach(async () => {
  cleanupSolid();
  document.body.innerHTML = "";
  fixture.listeners.clear();
  fixture.code = undefined;
  fixture.expired = false;
  fixture.uncertain = false;
  fixture.decide.mockReset();
});

describe("local owner matching-number dialog", () => {
  it("updates without refresh and defaults to no expiry before explicit approval", async () => {
    const done = showOwnerApprovalDialog({
      client: {} as GatewayBrowserClient,
      onDevices: vi.fn(),
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("Firefox on Linux"));
    const approve = () =>
      [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("The numbers match"),
      )!;
    expect(approve().disabled).toBe(true);
    expect(document.body.textContent).not.toContain("verified");
    fixture.code = "004210";
    fixture.listeners.forEach((listener) => listener());
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("004 210");
      expect(approve().disabled).toBe(false);
    });
    expect(document.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("");
    approve().click();
    expect(fixture.decide).toHaveBeenCalledWith("request", true, null);
    [...document.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Close")!
      .click();
    await done;
  });
  it("removes confirmation for expired or uncertain requests and opens Your devices", async () => {
    fixture.code = "482917";
    const request = vi.fn(async (method: string) =>
      method === "openclawId.people"
        ? { link: { linked: true, ownerDevices: [] } }
        : { channel: "local_operator" },
    );
    // SAFETY: these dialogs consume only request from the Gateway client.
    const client = { request } as unknown as GatewayBrowserClient;
    const done = showOwnerApprovalDialog({
      client,
      onDevices: () => void showOwnerDevicesDialog({ client }),
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("482 917"));
    fixture.expired = true;
    fixture.listeners.forEach((listener) => listener());
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("The numbers match"));
    expect(document.body.textContent).toContain("expired or was cancelled");
    expect(document.querySelector("input")).toBeNull();
    expect(fixture.decide).not.toHaveBeenCalled();
    fixture.code = undefined;
    fixture.listeners.forEach((listener) => listener());
    await vi.waitFor(() =>
      expect(document.body.textContent).not.toContain("Waiting for the other browser"),
    );
    fixture.code = "482917";
    fixture.uncertain = true;
    fixture.listeners.forEach((listener) => listener());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Your devices"));
    expect(
      [...document.querySelectorAll("button")].some((button) => button.textContent === "Retry"),
    ).toBe(false);
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Your devices")!
      .click();
    await done;
    await vi.waitFor(() => expect(document.querySelector("h2")?.textContent).toBe("Your devices"));
    document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
  });
});
