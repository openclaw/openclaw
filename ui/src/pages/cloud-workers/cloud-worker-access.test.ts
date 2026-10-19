/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  button,
  mountPage,
  setupSnapshotsDomSuite,
} from "./cloud-worker-snapshots-dom.test-support.ts";
import {
  buildEnvironmentFixture,
  snapshotListFixture,
} from "./cloud-worker-snapshots.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/confirm-dialog.ts")>()),
  showConfirmDialog: vi.fn(),
}));
vi.mock("../../lib/toast.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/toast.ts")>()),
  showToast: vi.fn(),
}));
setupSnapshotsDomSuite();
const methods = ["environments.list", "crabbox.images.list", "config.patch"];

describe("Cloud worker access retirement", () => {
  it.each(["environments.list", "crabbox.images.list"])(
    "retires a pending %s response when admin access is revoked on the same client",
    async (pendingMethod) => {
      const pending = createDeferred<unknown>();
      let hold = true;
      const inventory = { environments: [buildEnvironmentFixture()] };
      const advertisedMethods =
        pendingMethod === "environments.list" ? ["environments.list", "config.patch"] : methods;
      const fixture = mountPage(advertisedMethods, {
        response: (method, params) => {
          if (method === pendingMethod && params?.projection !== "profiles" && hold) {
            return pending.promise;
          }
          return method === "environments.list" && params?.includePreparedDetails
            ? inventory
            : undefined;
        },
      });
      try {
        await waitForSolid(() =>
          expect(fixture.request).toHaveBeenCalledWith(
            pendingMethod,
            pendingMethod === "environments.list" ? { includePreparedDetails: true } : {},
          ),
        );
        fixture.harness.publish(
          true,
          fixture.client,
          gatewayHelloForMethods(advertisedMethods, ["operator.read"]),
        );
        flush();
        expect(fixture.page.querySelector(".cloud-environments__row")).toBeNull();
        hold = false;
        pending.resolve(pendingMethod === "environments.list" ? inventory : snapshotListFixture());
        await Promise.all(fixture.request.mock.results.map((result) => result.value));
        flush();
        expect(fixture.page.querySelector(".cloud-environments__row")).toBeNull();
        expect(fixture.page.textContent).not.toContain("github.com/acme/app");
        expect(fixture.page.textContent).not.toContain("legacy-worker");

        fixture.harness.publish(true, fixture.client, gatewayHelloForMethods(advertisedMethods));
        window.dispatchEvent(new Event("focus"));
        await waitForSolid(() => expect(fixture.page.textContent).toContain("github.com/acme/app"));
      } finally {
        fixture.dispose();
      }
    },
  );

  it("retires machine-profile drafts and a pending catalog after admin access is revoked", async () => {
    const pending = createDeferred<unknown>();
    const fixture = mountPage(methods, {
      config: {
        cloudWorkers: {
          profiles: {
            linux: { provider: "crabbox", settings: { provider: "aws", class: "standard" } },
          },
        },
      },
      response: (method, params) =>
        method === "environments.list" && params?.projection === "profiles"
          ? pending.promise
          : undefined,
    });
    try {
      const edit = await waitForSolid(() => {
        const control = button(fixture.page, "Edit");
        expect(control.disabled).toBe(false);
        return control;
      });
      edit.click();
      flush();
      for (const label of ["Setup command", "Setup environment names"]) {
        const field = expectDefined(
          fixture.page.querySelector<HTMLInputElement | HTMLTextAreaElement>(
            `[aria-label="${label}"]`,
          ),
          label,
        );
        field.value = "Unsaved private setup";
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
      flush();
      fixture.harness.publish(
        true,
        fixture.client,
        gatewayHelloForMethods(methods, ["operator.read"]),
      );
      flush();
      expect(fixture.page.querySelector('[aria-label="Setup command"]')).toBeNull();
      expect(fixture.page.querySelector('[aria-label="Setup environment names"]')).toBeNull();
      pending.resolve({ environments: [], profiles: [{ id: "linux" }] });
      await Promise.all(fixture.request.mock.results.map((result) => result.value));
      flush();
      expect(fixture.page.textContent).not.toContain("Advertised");
      expect(fixture.page.textContent).not.toContain("Unsaved private setup");
    } finally {
      fixture.dispose();
    }
  });
});
