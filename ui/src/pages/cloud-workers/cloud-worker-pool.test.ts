/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentSummary,
  EnvironmentsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  button,
  mountPage,
  setupSnapshotsDomSuite,
} from "./cloud-worker-snapshots-dom.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
type Preparation = NonNullable<EnvironmentSummary["preparation"]>;

function preparedWorker(
  id: string,
  options: {
    status?: EnvironmentSummary["status"];
    worker?: Partial<NonNullable<EnvironmentSummary["worker"]>>;
    purpose?: Preparation["purpose"];
    details?: Partial<NonNullable<Preparation["details"]>>;
  } = {},
): EnvironmentSummary {
  return {
    id,
    type: "worker",
    status: options.status ?? "available",
    worker: {
      providerId: "crabbox",
      profileId: "linux",
      state: "ready",
      ageMs: 60_000,
      attachedSessionIds: [],
      tunnelStatus: "stopped",
      ...options.worker,
    },
    preparation: {
      purpose: options.purpose ?? "reserve",
      key: `preparation-${id}`,
      details: {
        demandAtMs: NOW - 60_000,
        expiresAtMs: NOW + 3_600_000,
        consumedAtMs: null,
        project: { label: id, baseCommit: "0123456789abcdef0123456789abcdef01234567" },
        ...options.details,
      },
    },
  };
}

function inventory(
  environments = [preparedWorker("App")],
  reservedEnvironmentIds = environments.map((environment) => environment.id),
): EnvironmentsListResult {
  return {
    environments,
    profiles: [
      { id: "linux", providerId: "crabbox", readyWorkers: 1 },
      { id: "linux-build", providerId: "crabbox", readyWorkers: 2 },
    ],
    preparedPool: { maxTotal: 4, reservedEnvironmentIds },
  };
}

function mountPool(
  readInventory: () => EnvironmentsListResult | Promise<EnvironmentsListResult>,
  scopes?: string[],
) {
  return mountPage(["environments.list"], {
    scopes,
    response: (method, params) =>
      method === "environments.list" && params?.projection !== "profiles"
        ? readInventory()
        : undefined,
  });
}

async function enterPool(fixture: ReturnType<typeof mountPage>) {
  await vi.advanceTimersByTimeAsync(0);
  button(fixture.page, "Pool").click();
  await vi.advanceTimersByTimeAsync(0);
  return expectDefined(fixture.page.querySelector("openclaw-cloud-worker-pool"), "Pool view");
}

setupSnapshotsDomSuite();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

afterEach(() => vi.restoreAllMocks());

describe("Cloud worker pool", () => {
  it("groups unused preparations and keeps reserve capacity separate from visible states", async () => {
    const fixture = mountPool(() =>
      inventory(
        [
          preparedWorker("Ready app"),
          preparedWorker("Building app", {
            status: "starting",
            purpose: "build",
            worker: { profileId: "linux-build", state: "provisioning" },
          }),
          preparedWorker("Releasing app", {
            worker: { destroyRequestedAtMs: NOW - 1_000 },
            details: { consumedAtMs: NOW - 2_000 },
          }),
          preparedWorker("Failed app", {
            status: "error",
            worker: { state: "failed", error: "Project preparation failed" },
          }),
          preparedWorker("Expired app", { details: { expiresAtMs: NOW - 1_000 } }),
          preparedWorker("Consumed app", { details: { consumedAtMs: NOW - 1_000 } }),
          preparedWorker("Attached app", { worker: { attachedSessionIds: ["session-app"] } }),
          preparedWorker("Destroyed app", { worker: { state: "destroyed" } }),
          { id: "Local", type: "local", status: "available" },
        ],
        ["Ready app", "Building app", "Releasing app", "Expired app"],
      ),
    );
    try {
      const pool = await enterPool(fixture);
      expect(pool.textContent).toContain("4 of 4 reserve slots in use");
      expect(
        [...pool.querySelectorAll(".settings-summary dt")].map((entry) => entry.textContent),
      ).toEqual(["Ready", "Preparing", "Releasing", "Needs attention"]);
      expect(
        [...pool.querySelectorAll(".settings-summary dd")].map((entry) => entry.textContent),
      ).toEqual(["1", "1", "1", "2"]);
      const profileSections = [...pool.querySelectorAll(".settings-section")].filter(
        (section) => section.querySelector("h2")?.textContent?.trim() !== "Ready pool",
      );
      expect(
        profileSections.map((section) =>
          section.querySelector("h2")?.textContent?.replace(/\s+/g, " ").trim(),
        ),
      ).toEqual(["linux 4", "linux-build 1"]);
      const linux = expectDefined(profileSections[0], "Linux profile");
      expect(linux.textContent).toContain("Ready workers per eligible project: 1");
      expect(
        [...linux.querySelectorAll(".settings-row__title")].map((row) => row.textContent?.trim()),
      ).toEqual(["Ready app", "Releasing app", "Failed app", "Expired app"]);
      expect(linux.textContent).toContain("01234567");
      expect(linux.textContent).toContain("Automatic reserve");
      expect(linux.textContent).toContain("Age: 1m");
      expect(linux.textContent).toContain("Project preparation failed");
      expect(linux.textContent).toContain("Expired");
      expect([...linux.querySelectorAll("time")].map((entry) => entry.dateTime)).toEqual([
        "2026-09-24T13:00:00.000Z",
        "2026-09-24T13:00:00.000Z",
        "2026-09-24T13:00:00.000Z",
        "2026-09-24T11:59:59.000Z",
      ]);
      const build = expectDefined(profileSections[1], "Build profile");
      expect(build.textContent).toContain("Ready workers per eligible project: 2");
      expect(build.textContent).toContain("Building app");
      expect(build.textContent).toContain("On-demand build");
      for (const excluded of ["Consumed app", "Attached app", "Destroyed app", "Local"]) {
        expect(pool.textContent).not.toContain(excluded);
      }
    } finally {
      fixture.dispose();
    }
  });

  it.each(["success", "error"] as const)(
    "ignores an old request's %s after a same-client reconnect",
    async (outcome) => {
      const oldRequest = createDeferred<EnvironmentsListResult>();
      const currentRequest = createDeferred<EnvironmentsListResult>();
      const readInventory = vi
        .fn(() => currentRequest.promise)
        .mockReturnValueOnce(oldRequest.promise);
      const fixture = mountPool(readInventory);
      try {
        const pool = await enterPool(fixture);
        expect(readInventory).toHaveBeenCalledTimes(1);
        fixture.harness.publish(
          false,
          fixture.client,
          gatewayHelloForMethods(["environments.list"]),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(pool.textContent).toContain("Connect to the Gateway to view the ready pool.");
        fixture.harness.publish(
          true,
          fixture.client,
          gatewayHelloForMethods(["environments.list"]),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(readInventory).toHaveBeenCalledTimes(2);
        if (outcome === "success") {
          oldRequest.resolve(inventory([preparedWorker("Old connection app")]));
        } else {
          oldRequest.reject(new Error("Old connection failure"));
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(pool.textContent).not.toContain("Old connection");
        expect(pool.querySelector('[role="alert"]')).toBeNull();
        expect(button(pool, "Refresh").disabled).toBe(true);
        currentRequest.resolve(inventory([preparedWorker("Current connection app")]));
        await vi.advanceTimersByTimeAsync(0);
        expect(pool.textContent).toContain("Current connection app");
        expect(button(pool, "Refresh").disabled).toBe(false);
      } finally {
        fixture.dispose();
      }
    },
  );

  it("keeps the last inventory when a refresh fails and clears the warning on recovery", async () => {
    const readInventory = vi
      .fn<() => Promise<EnvironmentsListResult>>()
      .mockResolvedValueOnce(inventory())
      .mockRejectedValueOnce(new Error("Worker inventory is unavailable"))
      .mockResolvedValueOnce(inventory([preparedWorker("Recovered app")]));
    const fixture = mountPool(readInventory);
    try {
      const pool = await enterPool(fixture);
      button(pool, "Refresh").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(pool.textContent).toContain("App");
      expect(pool.textContent).toContain("1 of 4 reserve slots in use");
      const warning = pool.querySelector('[role="alert"]');
      expect(warning?.textContent).toContain(
        "Could not refresh the pool: Worker inventory is unavailable.",
      );
      expect(warning?.textContent).toContain("Showing the last update from");
      expect(button(pool, "Refresh").disabled).toBe(false);
      button(pool, "Refresh").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(pool.textContent).toContain("Recovered app");
      expect(pool.querySelector('[role="alert"]')).toBeNull();
      expect(readInventory).toHaveBeenCalledTimes(3);
    } finally {
      fixture.dispose();
    }
  });

  it("refreshes every ten seconds only while the Pool tab is visible and mounted", async () => {
    const readInventory = vi.fn(() => inventory());
    const fixture = mountPool(readInventory);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(readInventory).not.toHaveBeenCalled();
      await enterPool(fixture);
      expect(readInventory).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(readInventory).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(readInventory).toHaveBeenCalledTimes(2);
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(readInventory).toHaveBeenCalledTimes(2);
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(readInventory).toHaveBeenCalledTimes(3);
      button(fixture.page, "Profiles").click();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(readInventory).toHaveBeenCalledTimes(3);
      await enterPool(fixture);
      expect(readInventory).toHaveBeenCalledTimes(4);
    } finally {
      fixture.dispose();
    }
    await vi.advanceTimersByTimeAsync(30_000);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(readInventory).toHaveBeenCalledTimes(4);
  });

  it("requires administrator scope before requesting pool inventory", async () => {
    const readInventory = vi.fn(() => inventory());
    const fixture = mountPool(readInventory, ["operator.read"]);
    try {
      const pool = await enterPool(fixture);
      expect(pool.textContent).toContain(
        "Administrator access is required to view the ready pool.",
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(readInventory).not.toHaveBeenCalled();
      expect(pool.querySelector("button")).toBeNull();
    } finally {
      fixture.dispose();
    }
  });

  it("shows pending cleanup after the pool has been disabled", async () => {
    const result = inventory([
      preparedWorker("Cleanup app", {
        worker: { destroyRequestedAtMs: NOW - 1_000 },
        details: { consumedAtMs: NOW - 2_000 },
      }),
    ]);
    result.preparedPool = { maxTotal: 0, reservedEnvironmentIds: ["Cleanup app"] };
    const fixture = mountPool(() => result);
    try {
      const pool = await enterPool(fixture);
      expect(pool.textContent).toContain("Unused workers awaiting release: 1");
      expect(pool.textContent).toContain("The pool is disabled.");
      expect(pool.textContent).toContain("Cleanup app");
      expect(pool.textContent).not.toContain("1 of 0");
    } finally {
      fixture.dispose();
    }
  });

  it("defers hidden entry and retires an unfinished inventory request on tab exit", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const pending = createDeferred<EnvironmentsListResult>();
    const readInventory = vi.fn(() => Promise.resolve(inventory([preparedWorker("Fresh app")])));
    readInventory.mockReturnValueOnce(pending.promise);
    const fixture = mountPool(readInventory);
    try {
      await enterPool(fixture);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(readInventory).not.toHaveBeenCalled();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(readInventory).toHaveBeenCalledTimes(1);
      button(fixture.page, "Profiles").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.request).toHaveBeenCalledWith(
        "environments.list",
        {},
        {
          signal: expect.objectContaining({ aborted: true }),
        },
      );
      pending.resolve(inventory([preparedWorker("Retired app")]));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(readInventory).toHaveBeenCalledTimes(1);
      const pool = await enterPool(fixture);
      expect(readInventory).toHaveBeenCalledTimes(2);
      expect(pool.textContent).toContain("Fresh app");
      expect(pool.textContent).not.toContain("Retired app");
    } finally {
      fixture.dispose();
    }
  });
});
