/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { button } from "./cloud-worker-snapshots-dom.test-support.ts";
import {
  buildEnvironmentFixture,
  snapshotListFixture,
} from "./cloud-worker-snapshots.test-support.ts";
import * as workers from "./cloud-workers.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/confirm-dialog.ts")>()),
  showConfirmDialog: vi.fn(),
}));
vi.mock("../../lib/toast.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/toast.ts")>()),
  showToast: vi.fn(),
}));
const mountPage = workers.setupSnapshotTests();
const methods = ["environments.list", "crabbox.images.list", "config.patch"];

it.each(["environments.list", "crabbox.images.list"])(
  "retires a pending %s response when admin access is revoked on the same client",
  async (pendingMethod) => {
    const pending = createDeferred<unknown>();
    let hold = true;
    const inventory = { environments: [buildEnvironmentFixture()] };
    const advertisedMethods =
      pendingMethod === "environments.list" ? ["environments.list", "config.patch"] : methods;
    const { page, request, harness, client } = mountPage(advertisedMethods, {
      response: (method, params) =>
        method === pendingMethod && params?.projection !== "profiles" && hold
          ? pending.promise
          : method === "environments.list" && params?.includePreparedDetails
            ? inventory
            : undefined,
    });
    await workers.waitRequest(
      request,
      pendingMethod,
      pendingMethod === "environments.list" ? { includePreparedDetails: true } : {},
    );
    harness.publish(true, client, gatewayHelloForMethods(advertisedMethods, ["operator.read"]));
    flush();
    expect(page.querySelector(".cloud-environments__row")).toBeNull();
    hold = false;
    pending.resolve(pendingMethod === "environments.list" ? inventory : snapshotListFixture());
    await Promise.all(request.mock.results.map((result) => result.value));
    flush();
    expect(page.querySelector(".cloud-environments__row")).toBeNull();
    expect(page.textContent).not.toContain("github.com/acme/app");
    expect(page.textContent).not.toContain("legacy-worker");

    harness.publish(true, client, gatewayHelloForMethods(advertisedMethods));
    window.dispatchEvent(new Event("focus"));
    await workers.waitText(() => page, "github.com/acme/app");
  },
);

it("retires machine-profile drafts and a pending catalog after admin access is revoked", async () => {
  const pending = createDeferred<unknown>();
  const { page, request, harness, client } = mountPage(methods, {
    config: { cloudWorkers: { profiles: { linux: workers.machineProfile() } } },
    response: (method, params) =>
      method === "environments.list" && params?.projection === "profiles"
        ? pending.promise
        : undefined,
  });
  await waitForSolid(() => expect(button(page, "Edit").disabled).toBe(false));
  button(page, "Edit").click();
  flush();
  for (const label of ["Setup command", "Setup environment names"]) {
    workers.change(
      expectDefined(
        page.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`),
        label,
      ),
      "Unsaved private setup",
    );
  }
  harness.publish(true, client, gatewayHelloForMethods(methods, ["operator.read"]));
  flush();
  expect(page.querySelector('[aria-label="Setup command"]')).toBeNull();
  expect(page.querySelector('[aria-label="Setup environment names"]')).toBeNull();
  pending.resolve({ environments: [], profiles: [{ id: "linux" }] });
  await Promise.all(request.mock.results.map((result) => result.value));
  flush();
  expect(page.textContent).not.toContain("Advertised");
  expect(page.textContent).not.toContain("Unsaved private setup");
});
