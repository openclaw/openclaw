/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { button } from "./cloud-worker-snapshots-dom.test-support.ts";
import {
  buildEnvironmentFixture,
  snapshotListFixture,
} from "./cloud-worker-snapshots.test-support.ts";
import {
  setupSnapshotTests,
  sheet,
  click,
  waitText,
  waitRequest,
  configSnapshot,
  makeWorker,
  preparedInventory,
  machineProfile,
  change,
} from "./cloud-workers.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));
const mountTestPage = setupSnapshotTests();
const methods = [
  "environments.list",
  "environments.prepare",
  "environments.destroy",
  "crabbox.images.list",
  "crabbox.images.recover",
];
function localSnapshot() {
  const result = snapshotListFixture();
  result.images = [
    Object.assign(expectDefined(result.images[0], "App snapshot"), {
      held: false,
      retirement: undefined,
      projectRoot: "/projects/app",
    }),
  ];
  return result;
}

it("rebuilds the selected local repository and shows capacity failures", async () => {
  const { page, request } = mountTestPage(methods, {
    result: localSnapshot(),
    response: (method) => {
      if (method === "environments.prepare") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "full",
          details: { code: "capacity" },
        });
      }
    },
  });
  await waitForSolid(() => expect(button(sheet(page), "Rebuild").disabled).toBe(false));
  click(sheet(page), "Rebuild");
  await waitText(() => page, "The prepared worker pool is full");
  expect(page.querySelector('[role="alert"]')?.textContent).toBe(
    "The prepared worker pool is full. Raise the prepared pool cap or destroy an unused worker, then try again.",
  );
  expect(request).toHaveBeenCalledWith("environments.prepare", {
    profileId: "linux-build",
    projectPath: "/projects/app",
  });
});

it("admits one rebuild when native clicks arrive before the next render", async () => {
  const preparation = createDeferred<unknown>();
  const { page, request } = mountTestPage(methods, {
    result: localSnapshot(),
    response: (method) => (method === "environments.prepare" ? preparation.promise : undefined),
  });
  const rebuild = await waitForSolid(() => {
    const control = button(sheet(page), "Rebuild");
    expect(control.disabled).toBe(false);
    return control;
  });
  try {
    rebuild.click();
    rebuild.click();
    expect(request.mock.calls.filter(([method]) => method === "environments.prepare")).toHaveLength(
      1,
    );
    await waitForSolid(() => expect(rebuild.disabled).toBe(true));
  } finally {
    preparation.resolve({ reused: false });
  }
  await waitForSolid(() => expect(rebuild.disabled).toBe(false));
});

it("releases a pending rebuild presentation when the same client reconnects", async () => {
  const preparation = createDeferred<unknown>();
  const { page, request, harness, client } = mountTestPage(methods, {
    result: localSnapshot(),
    response: (method) => (method === "environments.prepare" ? preparation.promise : undefined),
  });
  try {
    await waitForSolid(() => expect(button(sheet(page), "Rebuild").disabled).toBe(false));
    click(sheet(page), "Rebuild");
    await waitRequest(request, "environments.prepare", {
      profileId: "linux-build",
      projectPath: "/projects/app",
    });
    await waitForSolid(() => expect(button(sheet(page), "Rebuild").disabled).toBe(true));
    harness.publish(false, client, null);
    harness.publish(true, client, gatewayHelloForMethods(methods));
    await waitForSolid(() => expect(button(sheet(page), "Rebuild").disabled).toBe(false));
  } finally {
    preparation.reject(new Error("Retired rebuild failure"));
    await preparation.promise.catch(() => {});
  }
  await waitForSolid(() => expect(page.textContent).not.toContain("Retired rebuild failure"));
});

it("keeps newer inventory feedback when an earlier rebuild fails", async () => {
  const preparation = createDeferred<unknown>();
  let reads = 0;
  const { page } = mountTestPage(methods, {
    result: localSnapshot(),
    response: (method, params) => {
      if (method === "environments.prepare") {
        return preparation.promise;
      }
      if (method === "environments.list" && params?.includePreparedDetails) {
        reads++;
      }
      return undefined;
    },
  });
  await waitForSolid(() => expect(button(sheet(page), "Rebuild").disabled).toBe(false));
  click(sheet(page), "Rebuild");
  await waitForSolid(() => expect(button(sheet(page), "Rebuild").disabled).toBe(true));
  const previousReads = reads;
  globalThis.dispatchEvent(new Event("focus"));
  await waitForSolid(() => expect(reads).toBeGreaterThan(previousReads));
  preparation.reject(new Error("Earlier rebuild failure"));
  await preparation.promise.catch(() => {});
  await waitForSolid(() => expect(button(sheet(page), "Rebuild").disabled).toBe(false));
  expect(page.textContent).not.toContain("Earlier rebuild failure");
});

it("refreshes rebuild eligibility after a machine configuration save", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let enabled = false;
  const configuration = () => ({
    cloudWorkers: {
      profiles: {
        "linux-build": machineProfile("standard", { target: "linux", warmImage: enabled }),
      },
    },
  });
  const { page, request } = mountTestPage([...methods, "config.patch"], {
    response: (method, params) => {
      if (method === "config.get") {
        return configSnapshot(configuration(), enabled ? "enabled" : "disabled");
      }
      if (method === "config.patch") {
        expect(
          JSON.parse(String(params?.raw)).cloudWorkers.profiles["linux-build"].settings.warmImage,
        ).toBe(true);
        enabled = true;
        return { config: configuration(), hash: "enabled" };
      }
      if (method === "crabbox.images.list") {
        const result = localSnapshot();
        result.profiles[0]!.warmImages = enabled ? "on" : "off";
        return result;
      }
      return undefined;
    },
  });
  await waitText(() => sheet(page), "01234567");
  expect(button(sheet(page), "Rebuild").disabled).toBe(true);
  await waitForSolid(() => expect(button(page, "Edit").disabled).toBe(false));
  click(page, "Edit");
  change(
    expectDefined(
      page.querySelector<HTMLSelectElement>('select[aria-label="Warm images"]'),
      "Warm images",
    ),
    "on",
  );
  button(page, "Save").click();
  await waitForSolid(() =>
    expect(page.querySelector('select[aria-label="Warm images"]')).toBeNull(),
  );
  await vi.advanceTimersByTimeAsync(250);
  flush();
  await waitForSolid(() => expect(button(sheet(page), "Rebuild").disabled).toBe(false));
  button(sheet(page), "Rebuild").click();
  await waitRequest(request, "environments.prepare", {
    profileId: "linux-build",
    projectPath: "/projects/app",
  });
});

it("keeps unlabeled builds inspectable and actionable in Advanced", async () => {
  let workers = [
    makeWorker("provisioning", { id: "unlabeled-pending", details: null }),
    makeWorker("failed", {
      id: "unlabeled-failed",
      error: "Unlabeled setup failed",
      details: { project: { baseCommit: "abcdef" } },
    }),
  ];
  const { page, request } = mountTestPage(methods, {
    result: { ...localSnapshot(), images: [], legacyLeases: [] },
    response: (method, params) => {
      if (method === "environments.list" && params?.includePreparedDetails) {
        return { environments: workers, profiles: [] };
      }
      if (method === "environments.destroy") {
        workers = workers.filter((worker) => worker.id !== params?.environmentId);
        return {};
      }
      return undefined;
    },
  });
  const advanced = expectDefined(page.querySelector(".cloud-environments__advanced"), "Advanced");
  await waitText(() => advanced, "Unlabeled setup failed");
  expect(page.querySelectorAll(".cloud-environments__row")).toHaveLength(0);
  button(advanced, "Cancel").click();
  await waitRequest(request, "environments.destroy", {
    environmentId: "unlabeled-pending",
  });
  await waitForSolid(() => expect(button(advanced, "Dismiss").disabled).toBe(false));
  button(advanced, "Dismiss").click();
  await waitRequest(request, "environments.destroy", {
    environmentId: "unlabeled-failed",
  });
  await waitForSolid(() => expect(advanced.textContent).not.toContain("Unlabeled setup failed"));
});

it.each([true, false])(
  "keeps ready-worker cleanup failures actionable (repository label: %s)",
  async (labeled) => {
    const worker = makeWorker("ready", {
      error: "Provider cleanup failed",
      status: "error",
      worker: { destroyRequestedAtMs: Date.now() },
      details: {
        project: { baseCommit: "abcdef", ...(labeled ? { label: "github.com/acme/app" } : {}) },
      },
    });
    const { page, request } = mountTestPage(methods, {
      result: { ...localSnapshot(), images: [], legacyLeases: [] },
      response: preparedInventory([worker]),
    });
    await waitText(() => page, "Provider cleanup failed");
    const surface = labeled
      ? sheet(page)
      : expectDefined(page.querySelector(".cloud-environments__advanced"), "Advanced");
    expect(surface.textContent).toContain("Needs attention");
    button(surface, "Cancel").click();
    await waitRequest(request, "environments.destroy", {
      environmentId: "build-app",
    });
  },
);

it("fences recovery when the connection changes during confirmation", async () => {
  const result = localSnapshot();
  result.images[0]!.capture = { selector: "capture-app", phase: "uncertain", stale: false };
  const fixture = mountTestPage(methods, {
    result,
    response: preparedInventory([buildEnvironmentFixture()]),
  });
  const confirmation = createDeferred<boolean>();
  vi.mocked(showConfirmDialog).mockReturnValue(confirmation.promise);
  await waitText(() => sheet(fixture.page), "Paused: uncertain");
  click(sheet(fixture.page), "Recover");
  await waitForSolid(() => expect(showConfirmDialog).toHaveBeenCalled());
  expect(vi.mocked(showConfirmDialog).mock.calls[0]?.[0].requiredAcknowledgement).toBe(
    "I stopped the owning capture and worker and reconciled provider artifacts",
  );
  fixture.harness.publish(false);
  flush();
  fixture.harness.publish(true, fixture.client, gatewayHelloForMethods(methods));
  flush();
  confirmation.resolve(true);
  await Promise.resolve();
  flush();
  expect(fixture.request).not.toHaveBeenCalledWith("crabbox.images.recover", expect.anything());
});
it("dismisses a failed build immediately even when its inventory refresh fails", async () => {
  let dismissed = false;
  const { page, request } = mountTestPage(methods, {
    result: localSnapshot(),
    response: (method, params) => {
      if (method === "environments.destroy") {
        dismissed = true;
        return {};
      }
      if (method === "environments.list" && params?.includePreparedDetails) {
        if (dismissed) {
          throw new Error("Inventory unavailable");
        }
        return {
          environments: [buildEnvironmentFixture("failed", "Setup failed")],
          profiles: [],
        };
      }
      return undefined;
    },
  });
  await waitText(() => sheet(page), "Setup failed");
  expect(page.querySelector(".cloud-environments__row")?.textContent).toBe(
    "github.com/acme/appNeeds attention",
  );
  click(sheet(page), "Dismiss");
  await waitText(() => page, "Inventory unavailable");
  expect(sheet(page).textContent).not.toContain("Setup failed");
  expect(request).toHaveBeenCalledWith("environments.destroy", {
    environmentId: "build-app",
  });
});
it("polls automatic preparation through worker readiness before reading the published snapshot", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let ready = false;
  let consumed = false;
  const build = buildEnvironmentFixture();
  build.preparation.purpose = "reserve";
  const result = localSnapshot();
  result.images = [];
  const { page, request } = mountTestPage(methods, {
    result,
    response: (method, params) => {
      if (method === "environments.list" && params?.includePreparedDetails) {
        return {
          environments: consumed
            ? []
            : [ready ? { ...build, worker: { ...build.worker, state: "ready" } } : build],
          profiles: [],
        };
      }
      if (method === "crabbox.images.list") {
        return ready ? localSnapshot() : result;
      }
      return undefined;
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(page.querySelector(".cloud-environments__row")?.textContent).toBe(
    "github.com/acme/appBuilding",
  );
  ready = true;
  await vi.advanceTimersByTimeAsync(10_000);
  flush();
  expect(page.querySelector(".cloud-environments__row")?.textContent).toContain("Ready ·");
  consumed = true;
  await vi.advanceTimersByTimeAsync(10_000);
  flush();
  const count = request.mock.calls.filter(
    ([method, params]) => method === "environments.list" && params?.includePreparedDetails,
  ).length;
  await vi.advanceTimersByTimeAsync(30_000);
  flush();
  expect(
    request.mock.calls.filter(
      ([method, params]) => method === "environments.list" && params?.includePreparedDetails,
    ),
  ).toHaveLength(count);
});
