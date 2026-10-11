/* @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import {
  renderDevicesContainer,
  getDevicesSection as getSection,
} from "../../test-helpers/devices-view.ts";

function findButton(scope: Element, label: string): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button ${label}`);
  }
  return button;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("pending pairing action deduplication", () => {
  it("does not disable approve when no pending action matches", () => {
    const container = renderDevicesContainer({
      devicesList: {
        pending: [
          {
            requestId: "req-3",
            deviceId: "pending-device",
            displayName: "Pending device",
            roles: ["operator"],
            scopes: ["operator.read"],
          },
        ],
        paired: [],
      },
      pendingPairingActions: new Set(["device:other-request:approve"]),
    });
    const section = getSection(container, "Pending approval");
    expect(findButton(section, "Approve").disabled).toBe(false);
    expect(findButton(section, "Reject").disabled).toBe(false);
  });
});
