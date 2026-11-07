/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { startOpenClawIdFeatureLifetime } from "../../lib/openclaw-id/feature-lifetime.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { showOwnerApprovalDialog } from "./owner-approval-dialog.tsx";

// Dialogs open only while the enabled feature's lifetime runs.
let endFeature = () => {};
beforeEach(() => {
  endFeature = startOpenClawIdFeatureLifetime();
});
afterEach(() => endFeature());

const fixture = vi.hoisted(() => ({
  code: undefined as string | undefined,
  listeners: new Set<() => void>(),
  decide: vi.fn(),
}));
// mock-isolation: the approval lifetime is driven by the test instead of a live Gateway mailbox.
vi.mock("../../lib/openclaw-id/owner-approval-lifetime.ts", () => ({
  ownerApprovalFor: () => ({
    read: () => ({
      ready: true,
      error: null,
      requests: [{ id: "request", label: "Firefox on Linux", code: fixture.code, busy: false }],
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
  fixture.decide.mockReset();
});

describe("local owner matching-number dialog", () => {
  it("updates without refresh and defaults to no expiry before explicit approval", async () => {
    const done = showOwnerApprovalDialog({ client: {} as GatewayBrowserClient });
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
      expect(document.body.textContent).toContain("004210");
      expect(approve().disabled).toBe(false);
    });
    expect(document.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("");
    approve().click();
    expect(fixture.decide).toHaveBeenCalledWith("request", true, null);
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Close")!
      .click();
    await done;
  });
});
