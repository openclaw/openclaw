/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { t } from "../../i18n/index.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  button,
  cleanups,
  clientFor,
  gatewayFixture,
  gatewaySnapshot,
  mountPage,
  responseFor,
} from "./devices-page.test-support.tsx";

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe("Devices inventory actions", () => {
  it.each(["success", "failure", "reconnect", "navigation"])(
    "presents a pending approval until %s without changing its owner",
    async (outcome) => {
      const approved = createDeferred<unknown>();
      const inventory = {
        paired: [{ deviceId: "paired-1", displayName: "Paired browser", roles: ["operator"] }],
        pending: [
          { requestId: "request-1", deviceId: "device-1", displayName: "Browser" },
          { requestId: "request-2", deviceId: "device-2", displayName: "Tablet" },
        ],
      };
      const request = vi.fn(async (method: string) => {
        if (method === "device.pair.approve") {
          return approved.promise;
        }
        if (method === "device.pair.list") {
          return structuredClone(inventory);
        }
        return responseFor(method);
      });
      const { client } = clientFor(request);
      const fixture = gatewayFixture(gatewaySnapshot(client));
      const page = mountPage(fixture, {
        nodes: [{ nodeId: "node-1" }],
        devicesList: inventory,
      });
      const approve = () => button(page.container, t("devices.inventory.approve"));
      await waitForSolid(() => expect(approve().disabled).toBe(false));
      const details = Array.from(
        page.container.querySelectorAll<HTMLDetailsElement>(".device-entry__details"),
      ).find((element) =>
        element.closest(".device-entry")?.textContent?.includes("Paired browser"),
      );
      if (!details) {
        throw new Error("Expected the paired browser details");
      }
      details.open = true;
      approve().click();
      try {
        await waitForSolid(() => expect(approve().disabled).toBe(true));
        expect(
          page.container.querySelector<HTMLButtonElement>('button[aria-label="Approve Tablet"]')
            ?.disabled,
        ).toBe(false);
        expect(details.isConnected).toBe(true);
        expect(details.open).toBe(true);
        expect(
          request.mock.calls.filter(([method]) => method === "device.pair.approve"),
        ).toHaveLength(1);
        if (outcome === "reconnect") {
          fixture.emitSnapshot(gatewaySnapshot(client, false));
          fixture.emitSnapshot(gatewaySnapshot(client));
          // A held old write must not keep the replacement connection pending.
          await waitForSolid(() => expect(approve().disabled).toBe(false));
        } else if (outcome === "navigation") {
          page.leaveRoute();
          await waitForSolid(() => expect(approve().disabled).toBe(false));
        } else if (outcome === "failure") {
          approved.reject(new Error("Approval denied"));
          await waitForSolid(() => expect(page.container.textContent).toContain("Approval denied"));
          expect(approve().disabled).toBe(false);
        } else {
          approved.resolve({});
          await waitForSolid(() => expect(approve().disabled).toBe(false));
        }
        if (outcome !== "reconnect") {
          expect(details.isConnected).toBe(true);
          expect(details.open).toBe(true);
        }
      } finally {
        approved.resolve({});
      }
    },
  );
});
