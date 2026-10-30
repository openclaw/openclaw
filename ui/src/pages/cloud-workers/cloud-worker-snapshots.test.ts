/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
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
  configPatch,
  configSnapshot,
  waitRequest,
  change,
  makeWorker,
  preparedInventory,
  machineProfile,
} from "./cloud-workers.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));
const mountTestPage = setupSnapshotTests();
const methods = ["environments.list", "crabbox.images.list", "config.patch"];

function input(page: Element, label: string) {
  return expectDefined(page.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`), label);
}
function localSnapshot() {
  const result = snapshotListFixture();
  result.images = [
    { ...result.images[0]!, held: false, retirement: undefined, projectRoot: "/projects/app" },
  ];
  return result;
}

describe("Cloud environments", () => {
  it.each(["rejection", "reconnect"])(
    "retains pool drafts across %s and retires stale feedback",
    async (mode) => {
      const pending = createDeferred<unknown>();
      let hold = true;
      const { page, request, harness, client } = mountTestPage(methods, {
        response: (method) => (method === "config.patch" && hold ? pending.promise : undefined),
      });
      await waitForSolid(() => expect(input(page, "Pool cap").disabled).toBe(false));
      change(input(page, "Pool cap"), "6");
      click(page, "Save pool");
      await configPatch(request);
      await waitForSolid(() => expect(button(page, "Save pool").disabled).toBe(true));
      expect(input(page, "Pool cap").value).toBe("6");
      if (mode === "reconnect") {
        harness.publish(false, client, null);
        harness.publish(true, client, gatewayHelloForMethods(methods));
        await waitForSolid(() => expect(button(page, "Save pool").disabled).toBe(false));
        pending.reject(new Error("Synthetic save failure"));
        await pending.promise.catch(() => {});
      } else {
        hold = false;
        pending.reject(new Error("Synthetic save failure"));
        await waitText(() => page, "Synthetic save failure");
        await waitForSolid(() => expect(button(page, "Save pool").disabled).toBe(false));
        expect(input(page, "Pool cap").value).toBe("6");
        click(page, "Save pool");
        await waitForSolid(() =>
          expect(request.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(
            2,
          ),
        );
      }
      await waitForSolid(() => expect(button(page, "Save pool").disabled).toBe(false));
      expect(page.textContent).not.toContain("Synthetic save failure");
    },
  );

  it("shows accepted inventory before images settle and retains details through a refresh", async () => {
    const inventory = createDeferred<unknown>();
    const images = createDeferred<unknown>();
    const refresh = createDeferred<unknown>();
    const result = localSnapshot();
    let reads = 0;
    const { page, harness, client } = mountTestPage([...methods, "environments.prepare"], {
      response: (method, params) => {
        if (method === "environments.list" && params?.includePreparedDetails) {
          return ++reads === 1 ? inventory.promise : refresh.promise;
        }
        return method === "crabbox.images.list" ? images.promise : undefined;
      },
    });
    try {
      await waitText(() => page, "Loading");
      inventory.resolve({ environments: [buildEnvironmentFixture("failed")], profiles: [] });
      await waitText(() => sheet(page), "github.com/acme/app");
      expect(button(sheet(page), "Rebuild").disabled).toBe(true);
      images.resolve(result);
      await waitForSolid(() => expect(button(sheet(page), "Rebuild").disabled).toBe(false));
      const row = page.querySelector(".cloud-environments__row");
      harness.publish(
        true,
        client,
        gatewayHelloForMethods(["environments.list", "environments.prepare"]),
      );
      await waitForSolid(() => expect(reads).toBe(2));
      await waitForSolid(() => expect(button(sheet(page), "Rebuild").disabled).toBe(true));
      expect(page.querySelector(".cloud-environments__row")).toBe(row);
      expect(sheet(page).textContent).toContain("01234567");
      refresh.resolve({ environments: [], profiles: [] });
      await waitForSolid(() => expect(page.querySelector(".cloud-environments__sheet")).toBeNull());
    } finally {
      inventory.resolve({ environments: [], profiles: [] });
      images.resolve(result);
      refresh.resolve({ environments: [], profiles: [] });
    }
  });

  it("coalesces inventory refreshes and ignores retired reads while the replacement is pending", async () => {
    const pending = Array.from({ length: 3 }, () => createDeferred<unknown>());
    const inventory = { environments: [], profiles: [] };
    const result = localSnapshot();
    const advertised = [...methods, "environments.prepare"];
    const withoutImages = advertised.filter((method) => method !== "crabbox.images.list");
    let reads = 0;
    const { page, harness, client } = mountTestPage(advertised, {
      result,
      response: (method, params) => {
        if (method !== "environments.list" || !params?.includePreparedDetails) {
          return undefined;
        }
        const request = reads++;
        return request > 0 && request <= pending.length ? pending[request - 1]!.promise : inventory;
      },
    });
    const invalidate = () => {
      harness.publish(true, client, gatewayHelloForMethods(withoutImages));
      harness.publish(true, client, gatewayHelloForMethods(advertised));
    };
    try {
      await waitForSolid(() => expect(button(sheet(page), "Rebuild").disabled).toBe(false));
      invalidate();
      await waitForSolid(() => expect(reads).toBe(2));
      invalidate();
      await waitForSolid(() => expect(button(sheet(page), "Rebuild").disabled).toBe(true));
      expect(reads).toBe(2);
      pending[0]!.resolve(inventory);
      await waitForSolid(() => expect(reads).toBe(3));
      harness.publish(false, client, null);
      harness.publish(true, client, gatewayHelloForMethods(advertised));
      await waitForSolid(() => expect(reads).toBe(4));
      pending[1]!.reject(new Error("Retired inventory failure"));
      await pending[1]!.promise.catch(() => {});
      flush();
      expect(button(sheet(page), "Rebuild").disabled).toBe(true);
      pending[2]!.resolve(inventory);
      await waitForSolid(() => expect(button(sheet(page), "Rebuild").disabled).toBe(false));
      expect(page.textContent).not.toContain("Retired inventory failure");
      // Reconnect's permission receipt and initial load coalesce into one trailing refresh.
      expect(reads).toBe(5);
      expect(page.querySelector('[role="alert"]')).toBeNull();
    } finally {
      for (const request of pending) {
        request.resolve(inventory);
      }
    }
  });

  it("retains loaded environments and pool/policy drafts through a blip, but retires them for another client", async () => {
    const { page, request, harness, client } = mountTestPage(methods);
    await waitForSolid(() => expect(input(page, "Refresh after").disabled).toBe(false));
    await waitText(() => page, "github.com/acme/app");
    change(input(page, "Pool cap"), "7");
    change(input(page, "Refresh after"), "6h");
    const hello = gatewayHelloForMethods(methods);
    harness.publish(false, client, null);
    flush();
    expect(input(page, "Pool cap").value).toBe("7");
    expect(input(page, "Refresh after").value).toBe("6h");
    expect(page.textContent).toContain("github.com/acme/app");
    expect(button(page, "Save pool").disabled).toBe(true);
    expect(button(page, "Save retention policy").disabled).toBe(true);
    harness.publish(true, client, hello);
    await waitForSolid(() => expect(button(page, "Save pool").disabled).toBe(false));
    expect(input(page, "Pool cap").value).toBe("7");
    expect(input(page, "Refresh after").value).toBe("6h");
    harness.publish(true, { request } as unknown as GatewayBrowserClient, hello);
    flush();
    expect(input(page, "Pool cap").value).not.toBe("7");
    expect(input(page, "Refresh after").value).toBe("24h");
  });

  it("combines repository defaults, images and workers into one minimal row and shows only the selected details", async () => {
    const result = localSnapshot();
    result.images.push({
      ...expectDefined(snapshotListFixture().images[2], "Uncertain snapshot"),
      projectLabel: "github.com/acme/paused",
    });
    result.images.push({
      ...result.images[0]!,
      profileKey: "other-profile",
      profileId: "arm-build",
      checkpointId: "older",
      createdAtMs: 1,
    });
    const ready = buildEnvironmentFixture("ready");
    ready.id = "ready";
    ready.preparation.details.project = { label: "github.com/acme/ready", baseCommit: "abcdef" };
    const { page } = mountTestPage(methods, {
      result,
      config: {
        cloudWorkers: {
          projectProfiles: {
            "github.com/acme/app": "linux-build",
            "github.com/acme/cold": "linux-build",
          },
        },
      },
      response: (method, params) =>
        method === "environments.list" && params?.includePreparedDetails
          ? {
              environments: [ready, buildEnvironmentFixture()],
              profiles: [],
              preparedPool: { maxTotal: 4, reservedEnvironmentIds: ["ready"] },
            }
          : undefined,
    });
    await waitForSolid(() =>
      expect(page.querySelectorAll(".cloud-environments__row")).toHaveLength(4),
    );
    const rows = [...page.querySelectorAll(".cloud-environments__row")];
    expect(rows.map((row) => row.textContent)).toEqual([
      "github.com/acme/appBuilding",
      "github.com/acme/coldCold only",
      "github.com/acme/pausedNeeds attention",
      expect.stringContaining("github.com/acme/readyReady ·"),
    ]);
    const details = sheet(page);
    expect(details.textContent).toContain("01234567");
    expect(
      [...details.querySelectorAll(".cloud-environments__snapshot")].map((row) =>
        row.getAttribute("aria-label"),
      ),
    ).toEqual(["linux-build", "arm-build"]);
    expect(details.querySelector(".cloud-environments__machine > span")?.textContent).toBe(
      "aws · standard · linux",
    );
    expect(details.textContent).not.toContain("Paused: uncertain");
    expect(page.querySelector("details")?.open).toBe(false);
    (rows[2] as HTMLButtonElement).click();
    flush();
    await waitText(() => sheet(page), "Paused: uncertain");
    expect(button(sheet(page), "Rebuild").disabled).toBe(true);
    expect(sheet(page).textContent).not.toContain("01234567");
  });

  it.each([false, true])(
    "renders recorded setup phases and failures with a newer successful profile: %s",
    async (newerSuccessfulProfile) => {
      const result = localSnapshot();
      const phaseDurationsMs = { onCreate: 1200, updateContent: 6400 };
      const failed = {
        ...result.images[0]!,
        recipePreparationAtMs: 1000,
        recipePreparation: {
          source: "devcontainer" as const,
          phaseDurationsMs,
          failure: {
            reason: "Dependency installation failed",
            outputTail: "synthetic package unavailable",
          },
        },
      };
      result.images = [
        failed,
        ...(newerSuccessfulProfile
          ? [
              {
                ...failed,
                profileKey: "large-profile",
                profileId: "large",
                recipePreparationAtMs: 2000,
                recipePreparation: { source: "devcontainer" as const, phaseDurationsMs },
              },
            ]
          : []),
      ];
      const { page } = mountTestPage(methods, { result });
      await waitText(() => sheet(page), "Dev Container");
      const details = sheet(page);
      expect(page.querySelector(".cloud-environments__row")?.textContent).toBe(
        "github.com/acme/appNeeds attention",
      );
      expect(details.querySelector(".cloud-environments__step--longest")?.textContent).toContain(
        "updateContentCommand",
      );
      expect(details.querySelector(".cloud-environments__output")?.textContent).toBe(
        "synthetic package unavailable",
      );
      if (newerSuccessfulProfile) {
        expect(details.querySelector('[role="alert"]')?.textContent).toContain("linux-build");
      }
    },
  );

  it("shows configured repositories without calling an unadvertised snapshot plugin", async () => {
    const { page, request } = mountTestPage(["environments.list"], {
      config: { cloudWorkers: { projectProfiles: { "github.com/acme/app": "linux" } } },
    });
    await waitForSolid(() =>
      expect(page.querySelector(".cloud-environments__row")?.textContent).toBe(
        "github.com/acme/appCold only",
      ),
    );
    expect(request).not.toHaveBeenCalledWith("crabbox.images.list", expect.anything());
    expect(button(sheet(page), "Rebuild").disabled).toBe(true);
  });

  it.each([
    { current: "linux-build", next: "large" },
    { current: undefined, next: "linux-build" },
  ])(
    "saves repository default $current → $next without replacing other defaults",
    async ({ current, next }) => {
      const { page, request } = mountTestPage(methods, {
        config: {
          cloudWorkers: {
            profiles: {
              "linux-build": machineProfile(),
              ...(current
                ? {
                    large: machineProfile("large"),
                  }
                : {}),
            },
            projectProfiles: {
              ...(current ? { "github.com/acme/app": current } : {}),
              "github.com/acme/other": "linux-build",
            },
          },
        },
      });
      await waitForSolid(() => expect(button(sheet(page), "Change").disabled).toBe(false));
      click(sheet(page), "Change");
      const select = expectDefined(
        sheet(page).querySelector<HTMLSelectElement>('select[aria-label="Default profile"]'),
        "Default profile selector",
      );
      expect(select.value).toBe(current ?? "");
      change(select, next);
      const patch = await configPatch(request);
      expect(JSON.parse(String(patch?.raw))).toEqual({
        cloudWorkers: { projectProfiles: { "github.com/acme/app": next } },
      });
      expect(patch?.baseHash).toBe("snapshot-config");
    },
  );

  it.each([0, 1])("validates retention minima and saves keepPrevious=%s", async (keepPrevious) => {
    const { page, request } = mountTestPage(methods);
    await waitForSolid(() => expect(input(page, "Refresh after").disabled).toBe(false));
    expect(
      page.querySelector('.cloud-environments__sheet input[aria-label="Refresh after"]'),
    ).toBeNull();
    change(input(page, "Refresh after"), "30m");
    click(page, "Save retention policy");
    await waitText(() => page, "Enter a duration of at least 1h");
    expect(request.mock.calls.some(([method]) => method === "config.patch")).toBe(false);
    change(input(page, "Refresh after"), "2h");
    change(input(page, "Retain unused"), "3d");
    const select = expectDefined(
      page.querySelector<HTMLSelectElement>('select[aria-label="Previous generations"]'),
      "Previous generations",
    );
    expect(select.value).toBe("0");
    change(select, String(keepPrevious));
    click(page, "Save retention policy");
    const patch = await configPatch(request);
    expect(JSON.parse(String(patch?.raw))).toEqual({
      plugins: {
        entries: {
          crabbox: {
            config: { warmImages: { refreshAfter: "2h", retainUnused: "3d", keepPrevious } },
          },
        },
      },
    });
  });

  it("counts only usable pool workers and keeps capacity editable in Advanced", async () => {
    const inventory = [
      makeWorker("ready"),
      ...(["unavailable", "error", "stopping"] as const).map((status) =>
        makeWorker("ready", { status }),
      ),
      makeWorker("ready", { details: { expiresAtMs: Date.now() - 1 } }),
      makeWorker("ready", { details: { consumedAtMs: Date.now() } }),
      makeWorker("ready", { details: null }),
      makeWorker("ready", { worker: { destroyRequestedAtMs: Date.now() } }),
      makeWorker("ready", { worker: { attachedSessionIds: ["active-session"] } }),
    ].map((environment, index) => Object.assign(environment, { id: `pool-${index}` }));
    const { page, request } = mountTestPage(methods, {
      response: preparedInventory(inventory),
    });
    await waitForSolid(() => expect(input(page, "Pool cap").disabled).toBe(false));
    await waitText(() => page, "1 ready workers · Pool cap");
    change(input(page, "Pool cap"), "6");
    click(page, "Save pool");
    const patch = await configPatch(request);
    expect(JSON.parse(String(patch?.raw))).toEqual({
      cloudWorkers: { preparedPool: { maxTotal: 6 } },
    });
  });
});

const buildMethods = [
  "environments.list",
  "environments.prepare",
  "environments.destroy",
  "crabbox.images.list",
  "crabbox.images.recover",
];
const rebuildButton = (page: Element) => button(sheet(page), "Rebuild");
const waitRebuild = (page: Element, disabled = false) =>
  waitForSolid(() => expect(rebuildButton(page).disabled).toBe(disabled));
const prepareParams = { profileId: "linux-build", projectPath: "/projects/app" };

it.each(["completion", "reconnect", "inventory refresh"] as const)(
  "admits one native rebuild and retires its presentation after %s",
  async (mode) => {
    const preparation = createDeferred<unknown>();
    let reads = 0;
    const { page, request, harness, client } = mountTestPage(buildMethods, {
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
    await waitRebuild(page);
    const rebuild = rebuildButton(page);
    try {
      rebuild.click();
      rebuild.click();
      expect(
        request.mock.calls.filter(([method]) => method === "environments.prepare"),
      ).toHaveLength(1);
      await waitRebuild(page, true);
      if (mode === "reconnect") {
        harness.publish(false, client, null);
        harness.publish(true, client, gatewayHelloForMethods(buildMethods));
        await waitRebuild(page);
      } else if (mode === "inventory refresh") {
        const previousReads = reads;
        globalThis.dispatchEvent(new Event("focus"));
        await waitForSolid(() => expect(reads).toBeGreaterThan(previousReads));
      }
    } finally {
      if (mode === "completion") {
        preparation.resolve({ reused: false });
      } else {
        preparation.reject(new Error("Earlier rebuild failure"));
      }
      await preparation.promise.catch(() => {});
    }
    await waitRebuild(page);
    expect(page.textContent).not.toContain("Earlier rebuild failure");
  },
);

it("refreshes rebuild eligibility after a machine save and shows capacity failures", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let enabled = false;
  const configuration = () => ({
    cloudWorkers: {
      profiles: {
        "linux-build": machineProfile("standard", { target: "linux", warmImage: enabled }),
      },
    },
  });
  const { page, request } = mountTestPage([...buildMethods, "config.patch"], {
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
      if (method === "environments.prepare") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "full",
          details: { code: "capacity" },
        });
      }
      return undefined;
    },
  });
  await waitText(() => sheet(page), "01234567");
  expect(rebuildButton(page).disabled).toBe(true);
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
  await waitRebuild(page);
  rebuildButton(page).click();
  await waitRequest(request, "environments.prepare", prepareParams);
  await waitText(() => page, "The prepared worker pool is full");
  expect(page.querySelector('[role="alert"]')?.textContent).toBe(
    "The prepared worker pool is full. Raise the prepared pool cap or destroy an unused worker, then try again.",
  );
});

it.each([
  { state: "provisioning", labeled: false, action: "Cancel", details: null },
  { state: "failed", labeled: false, action: "Dismiss", details: {} },
  { state: "ready", labeled: false, action: "Cancel", details: {} },
  { state: "ready", labeled: true, action: "Cancel", details: {} },
])(
  "keeps $state builds actionable (repository label: $labeled)",
  async ({ state, labeled, action, details }) => {
    const worker = makeWorker(state, {
      error: state === "provisioning" ? undefined : "Worker cleanup failed",
      ...(state === "ready"
        ? { status: "error", worker: { destroyRequestedAtMs: Date.now() } }
        : {}),
      details:
        details === null
          ? null
          : {
              project: {
                baseCommit: "abcdef",
                ...(labeled ? { label: "github.com/acme/app" } : {}),
              },
            },
    });
    let dismissed = false;
    const { page, request } = mountTestPage(buildMethods, {
      result: { ...localSnapshot(), images: [], legacyLeases: [] },
      response: (method, params) => {
        if (method === "environments.destroy") {
          dismissed = true;
          return {};
        }
        if (
          dismissed &&
          state === "failed" &&
          method === "environments.list" &&
          params?.includePreparedDetails
        ) {
          throw new Error("Inventory unavailable");
        }
        return preparedInventory([worker])(method, params);
      },
    });
    const surface = labeled
      ? await waitForSolid(() => sheet(page))
      : expectDefined(page.querySelector(".cloud-environments__advanced"), "Advanced");
    await waitForSolid(() => expect(button(surface, action).disabled).toBe(false));
    if (state !== "provisioning") {
      expect(surface.textContent).toContain("Worker cleanup failed");
    }
    if (state === "ready") {
      expect(surface.textContent).toContain("Needs attention");
    }
    if (!labeled) {
      expect(page.querySelectorAll(".cloud-environments__row")).toHaveLength(0);
    }
    button(surface, action).click();
    await waitRequest(request, "environments.destroy", {
      environmentId: "build-app",
    });
    if (state === "failed") {
      await waitText(() => page, "Inventory unavailable");
      await waitForSolid(() => expect(surface.textContent).not.toContain("Worker cleanup failed"));
    }
  },
);

it("fences recovery when the connection changes during confirmation", async () => {
  const result = localSnapshot();
  result.images[0]!.capture = { selector: "capture-app", phase: "uncertain", stale: false };
  const fixture = mountTestPage(buildMethods, {
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
  fixture.harness.publish(true, fixture.client, gatewayHelloForMethods(buildMethods));
  flush();
  confirmation.resolve(true);
  await Promise.resolve();
  flush();
  expect(fixture.request).not.toHaveBeenCalledWith("crabbox.images.recover", expect.anything());
});
it("polls automatic preparation through worker readiness before reading the published snapshot", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let ready = false;
  let consumed = false;
  const build = buildEnvironmentFixture();
  build.preparation.purpose = "reserve";
  const result = localSnapshot();
  result.images = [];
  const { page, request } = mountTestPage(buildMethods, {
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
