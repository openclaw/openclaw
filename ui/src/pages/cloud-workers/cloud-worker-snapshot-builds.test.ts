/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  button,
  mountPage,
  setupSnapshotsDomSuite,
} from "./cloud-worker-snapshots-dom.test-support.ts";
import { snapshotListFixture } from "./cloud-worker-snapshots.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));

setupSnapshotsDomSuite();

const buildMethods = [
  "crabbox.images.list",
  "environments.list",
  "environments.prepare",
  "environments.destroy",
  "projects.list",
  "worktrees.list",
];

function buildFixture(state = "provisioning", error?: string) {
  return {
    id: "build-app",
    type: "worker",
    status: "starting",
    preparation: { purpose: "build", key: "build-key" },
    worker: {
      profileId: "linux-build",
      providerId: "crabbox",
      leaseId: "lease-app",
      state,
      ageMs: 60_000,
      attachedSessionIds: [],
      tunnelStatus: "stopped",
      ...(error ? { error } : {}),
    },
  };
}

async function openSnapshots(fixture: ReturnType<typeof mountPage>) {
  await waitForFast(() => expect(fixture.page.textContent).toContain("No cloud worker profiles"));
  button(fixture.page, "Snapshots").click();
  await waitForFast(() => expect(fixture.page.querySelector(".settings-summary")).not.toBeNull());
  return expectDefined(
    fixture.page.querySelector("openclaw-cloud-worker-snapshots"),
    "Snapshots view",
  );
}

function select(container: Element, index: number, value: string) {
  const input = expectDefined(container.querySelectorAll("select")[index], "Build selection");
  input.value = value;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function openBuild(snapshots: Element) {
  button(snapshots, "Build snapshot").click();
  await waitForFast(() => expect(snapshots.querySelectorAll("option").length).toBeGreaterThan(4));
  return expectDefined(snapshots.querySelector("openclaw-modal-dialog"), "Build dialog");
}

async function chooseBuild(dialog: Element) {
  select(dialog, 0, "linux-build");
  select(dialog, 1, "/projects/app");
  await waitForFast(() => expect(button(dialog, "Build snapshot").disabled).toBe(false));
}

describe("Snapshot builds", () => {
  it.each([false, true])(
    "validates choices and submits the local repository root (reused=%s)",
    async (reused) => {
      const fixture = mountPage(buildMethods, {
        response: (method) => (method === "environments.prepare" ? { reused } : undefined),
      });
      try {
        const snapshots = await openSnapshots(fixture);
        const dialog = await openBuild(snapshots);
        const submit = button(dialog, "Build snapshot");
        expect(submit.disabled).toBe(true);
        const disabledProfile = expectDefined(
          dialog.querySelector<HTMLOptionElement>('option[value="cold-build"]'),
          "Disabled cold profile",
        );
        expect(disabledProfile.disabled).toBe(true);
        expect(disabledProfile.textContent).toContain("Warm images are explicitly disabled.");
        select(dialog, 0, "linux-build");
        await Promise.resolve();
        expect(submit.disabled).toBe(true);
        await chooseBuild(dialog);
        submit.click();
        await waitForFast(() =>
          expect(snapshots.textContent).toContain(
            reused ? "Reusing the build already in progress" : "Build started",
          ),
        );
        expect(fixture.request).toHaveBeenCalledWith("environments.prepare", {
          profileId: "linux-build",
          projectPath: "/projects/app",
        });
        expect(snapshots.querySelector("openclaw-modal-dialog")).toBeNull();
      } finally {
        fixture.dispose();
      }
    },
  );

  it("keeps a pending build dialog open and displays its eventual error", async () => {
    const pending = deferred<{ reused: boolean }>();
    const fixture = mountPage(buildMethods, {
      response: (method) => (method === "environments.prepare" ? pending.promise : undefined),
    });
    try {
      const snapshots = await openSnapshots(fixture);
      const dialog = await openBuild(snapshots);
      await chooseBuild(dialog);
      button(dialog, "Build snapshot").click();
      await waitForFast(() => expect(button(dialog, "Cancel").disabled).toBe(true));
      const dismiss = new CustomEvent("modal-cancel", { cancelable: true, bubbles: true });
      dialog.dispatchEvent(dismiss);
      expect(dismiss.defaultPrevented).toBe(true);
      pending.reject(
        new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "Preparation failed",
          details: { code: "capacity" },
        }),
      );
      await waitForFast(() => expect(dialog.textContent).toContain("Raise the prepared pool cap"));
      expect(button(dialog, "Cancel").disabled).toBe(false);
      dialog.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true, bubbles: true }));
      await waitForFast(() => expect(snapshots.querySelector("openclaw-modal-dialog")).toBeNull());
    } finally {
      pending.resolve({ reused: false });
      fixture.dispose();
    }
  });

  it.each([
    ["capacity", "Raise the prepared pool cap or destroy an unused worker"],
    ["invalid_project", "accessible local Git checkout root with a HEAD commit"],
    ["invalid_profile", "does not support project preparation"],
    ["profile_not_found", "does not support project preparation"],
  ])("keeps %s errors inline with a recovery action", async (code, message) => {
    const fixture = mountPage(buildMethods, {
      response: (method) => {
        if (method === "environments.prepare") {
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Preparation failed",
            details: { code },
          });
        }
      },
    });
    try {
      const snapshots = await openSnapshots(fixture);
      const dialog = await openBuild(snapshots);
      await chooseBuild(dialog);
      button(dialog, "Build snapshot").click();
      await waitForFast(() =>
        expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(message),
      );
      expect(button(dialog, "Build snapshot").disabled).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it.each([true, false])(
    "rebuilds project roots independently of optional labels (label=%s)",
    async (hasLabel) => {
      const images = snapshotListFixture();
      const project = expectDefined(images.images[0], "Project snapshot");
      const fixture = mountPage(buildMethods, {
        response: (method) =>
          method === "crabbox.images.list"
            ? {
                ...images,
                images: [
                  {
                    ...project,
                    projectLabel: hasLabel ? project.projectLabel : undefined,
                    projectRoot: "/projects/app",
                  },
                  ...images.images.slice(1),
                ],
              }
            : undefined,
      });
      try {
        const snapshots = await openSnapshots(fixture);
        expect(
          [...snapshots.querySelectorAll("button")].filter(
            (entry) => entry.textContent?.trim() === "Rebuild",
          ),
        ).toHaveLength(1);
        button(snapshots, "Rebuild").click();
        await waitForFast(() =>
          expect(fixture.request).toHaveBeenCalledWith("environments.prepare", {
            profileId: "linux-build",
            projectPath: "/projects/app",
          }),
        );
      } finally {
        fixture.dispose();
      }
    },
  );

  it("loads the published image after observing worker readiness", async () => {
    const ready = deferred<{ environments: Array<ReturnType<typeof buildFixture>> }>();
    const result = snapshotListFixture();
    let images: typeof result.images = [];
    const fixture = mountPage(buildMethods, {
      response: (method) =>
        method === "environments.list"
          ? ready.promise
          : method === "crabbox.images.list"
            ? { ...result, images }
            : undefined,
    });
    try {
      await waitForFast(() =>
        expect(fixture.page.textContent).toContain("No cloud worker profiles"),
      );
      button(fixture.page, "Snapshots").click();
      await waitForFast(() =>
        expect(fixture.request).toHaveBeenCalledWith("environments.list", {}),
      );
      images = [expectDefined(result.images[0], "Published project image")];
      ready.resolve({ environments: [buildFixture("ready")] });
      await waitForFast(() => expect(fixture.page.textContent).toContain("github.com/acme/app"));
    } finally {
      fixture.dispose();
    }
  });

  it.each(["provisioning", "failed"] as const)(
    "shows an admitted %s build when the first image inventory fails",
    async (state) => {
      let environments = [
        buildFixture(state, state === "failed" ? "Setup recipe failed" : undefined),
      ];
      let failImages = true;
      const result = { ...snapshotListFixture(), images: [], legacyLeases: [] };
      const fixture = mountPage(buildMethods, {
        response: (method) => {
          if (method === "environments.list") {
            return { environments };
          }
          if (method === "crabbox.images.list") {
            if (failImages) {
              throw new Error("Image inventory is unavailable");
            }
            return result;
          }
          if (method === "environments.destroy") {
            environments = [];
            return {};
          }
          return undefined;
        },
      });
      try {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await waitForFast(() =>
          expect(fixture.page.textContent).toContain("No cloud worker profiles"),
        );
        button(fixture.page, "Snapshots").click();
        await waitForFast(() =>
          expect(fixture.page.textContent).toContain("Image inventory is unavailable"),
        );
        const snapshots = expectDefined(
          fixture.page.querySelector("openclaw-cloud-worker-snapshots"),
          "Snapshots view",
        );
        expect(snapshots.textContent).toContain("build-app");
        const imageTotal = () =>
          [...snapshots.querySelectorAll(".settings-summary dt")].find(
            (entry) => entry.textContent === "Images",
          )?.nextElementSibling?.textContent;
        expect(imageTotal()).toBeUndefined();
        const imageReads = () =>
          fixture.request.mock.calls.filter(([method]) => method === "crabbox.images.list").length;
        const readsBeforePoll = imageReads();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(imageReads()).toBe(readsBeforePoll + (state === "provisioning" ? 1 : 0));
        if (state === "provisioning") {
          expect(snapshots.textContent).toContain("Provisioning");
          expect(button(snapshots, "Cancel").disabled).toBe(false);
          button(snapshots, "Cancel").click();
          await waitForFast(() =>
            expect(fixture.request).toHaveBeenCalledWith("environments.destroy", {
              environmentId: "build-app",
            }),
          );
          await waitForFast(() => expect(snapshots.textContent).not.toContain("build-app"));
        } else {
          expect(snapshots.textContent).toContain("Setup recipe failed");
          expect(
            [...snapshots.querySelectorAll("button")].some(
              (entry) => entry.textContent?.trim() === "Cancel",
            ),
          ).toBe(false);
        }
        failImages = false;
        await waitForFast(() => expect(button(snapshots, "Refresh").disabled).toBe(false));
        button(snapshots, "Refresh").click();
        await waitForFast(() => expect(imageTotal()).toBe("0"));
        expect(snapshots.textContent).not.toContain("Image inventory is unavailable");
        if (state === "failed") {
          expect(snapshots.textContent).toContain("Setup recipe failed");
        }
      } finally {
        fixture.dispose();
      }
    },
  );

  it("retains an admitted active build and polling when the image inventory fails", async () => {
    let environments: Array<ReturnType<typeof buildFixture>> = [];
    let failImages = false;
    const result = { ...snapshotListFixture(), images: [] };
    const fixture = mountPage(buildMethods, {
      response: (method) => {
        if (method === "environments.list") {
          return { environments };
        }
        if (method === "crabbox.images.list") {
          if (failImages) {
            throw new Error("Image inventory is unavailable");
          }
          return result;
        }
        if (method === "environments.prepare") {
          environments = [buildFixture()];
          failImages = true;
          return { reused: false };
        }
        return undefined;
      },
    });
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const snapshots = await openSnapshots(fixture);
      const dialog = await openBuild(snapshots);
      await chooseBuild(dialog);
      button(dialog, "Build snapshot").click();
      await waitForFast(() =>
        expect(snapshots.textContent).toContain("Image inventory is unavailable"),
      );
      expect(snapshots.textContent).toContain("build-app");
      expect(snapshots.querySelectorAll(".settings-summary dd")[1]?.textContent).toBe("1");
      const calls = fixture.request.mock.calls.length;
      failImages = false;
      environments = [buildFixture("ready")];
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fixture.request).toHaveBeenCalledTimes(calls + 2);
      expect(snapshots.textContent).not.toContain("Image inventory is unavailable");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fixture.request).toHaveBeenCalledTimes(calls + 2);
    } finally {
      fixture.dispose();
    }
  });

  it("groups builds, deduplicates captures, and polls until both workers and captures settle", async () => {
    let builds = [buildFixture()];
    const result = snapshotListFixture();
    const images = result.images.map((image) =>
      image.capture?.phase === "creating"
        ? { ...image, capture: { ...image.capture, leaseId: "lease-app" } }
        : image,
    );
    const fixture = mountPage(buildMethods, {
      response: (method) =>
        method === "environments.list"
          ? { environments: builds }
          : method === "crabbox.images.list"
            ? { ...result, images }
            : undefined,
    });
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const snapshots = await openSnapshots(fixture);
      const group = expectDefined(
        [...snapshots.querySelectorAll(".settings-section")].find((entry) =>
          entry.querySelector("h2")?.textContent?.includes("linux-build"),
        ),
        "Build profile group",
      );
      expect(group.textContent).toContain("build-app");
      expect(group.textContent).toContain("Provisioning");
      expect(group.textContent).toContain("Age: 1m");
      expect(snapshots.querySelectorAll(".settings-summary dd")[1]?.textContent).toBe("1");
      const imageCalls = () =>
        fixture.request.mock.calls.filter(([method]) => method === "crabbox.images.list").length;
      const environmentCalls = () =>
        fixture.request.mock.calls.filter(([method]) => method === "environments.list").length;
      const before = environmentCalls();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(imageCalls()).toBe(2);
      expect(environmentCalls()).toBe(before + 1);
      builds = [buildFixture("ready")];
      await vi.advanceTimersByTimeAsync(10_000);
      expect(snapshots.textContent).not.toContain("build-app");
      expect(imageCalls()).toBe(3);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(imageCalls()).toBe(4);
      for (const image of images) {
        if (image.capture?.phase === "creating") {
          image.capture = undefined;
        }
      }
      await vi.advanceTimersByTimeAsync(10_000);
      expect(imageCalls()).toBe(5);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(imageCalls()).toBe(5);
      button(snapshots, "Refresh").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(imageCalls()).toBe(6);
      expect(environmentCalls()).toBe(before + 5);
    } finally {
      fixture.dispose();
    }
  });

  it.each(["failed", "orphaned"])(
    "keeps an admitted build's %s outcome visible without continued polling",
    async (state) => {
      let environments: Array<ReturnType<typeof buildFixture>> = [];
      const result = { ...snapshotListFixture(), images: [] };
      const fixture = mountPage(buildMethods, {
        response: (method) => {
          if (method === "environments.list") {
            return { environments };
          }
          if (method === "crabbox.images.list") {
            return result;
          }
          if (method === "environments.prepare") {
            environments = [buildFixture()];
            return { reused: false };
          }
          return undefined;
        },
      });
      try {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const snapshots = await openSnapshots(fixture);
        const dialog = await openBuild(snapshots);
        await chooseBuild(dialog);
        button(dialog, "Build snapshot").click();
        await waitForFast(() => expect(snapshots.textContent).toContain("Build started"));
        environments = [buildFixture(state, "Setup recipe failed")];
        await vi.advanceTimersByTimeAsync(10_000);
        expect(snapshots.textContent).toContain("build-app");
        expect(snapshots.querySelector('[role="alert"]')?.textContent).toContain(
          "Setup recipe failed",
        );
        expect(snapshots.textContent).not.toContain("Build started");
        expect(snapshots.querySelectorAll(".settings-summary dd")[1]?.textContent).toBe("0");
        expect(snapshots.querySelectorAll(".settings-summary dd")[3]?.textContent).toBe("1");
        expect(
          [...snapshots.querySelectorAll("button")].some(
            (entry) => entry.textContent?.trim() === "Cancel",
          ),
        ).toBe(false);
        expect(
          [...snapshots.querySelectorAll("button")].some(
            (entry) => entry.textContent?.trim() === "Dismiss",
          ),
        ).toBe(state === "failed");
        const calls = fixture.request.mock.calls.length;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fixture.request).toHaveBeenCalledTimes(calls);
      } finally {
        fixture.dispose();
      }
    },
  );

  it("counts distinct captures and build environments and cancels by environment ID", async () => {
    let environments = [buildFixture()];
    const fixture = mountPage(buildMethods, {
      response: (method) => {
        if (method === "environments.list") {
          return { environments };
        }
        if (method === "environments.destroy") {
          environments = [];
          return {};
        }
        return undefined;
      },
    });
    try {
      const snapshots = await openSnapshots(fixture);
      expect(snapshots.querySelectorAll(".settings-summary dd")[1]?.textContent).toBe("2");
      button(snapshots, "Cancel").click();
      await waitForFast(() => expect(snapshots.textContent).toContain("Build canceled"));
      expect(vi.mocked(showConfirmDialog)).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Cancel build", details: "build-app" }),
      );
      expect(fixture.request).toHaveBeenCalledWith("environments.destroy", {
        environmentId: "build-app",
      });
      expect(snapshots.textContent).not.toContain("build-app");
    } finally {
      fixture.dispose();
    }
  });

  it("dismisses a failed build before refresh finishes and keeps it hidden after refresh fails", async () => {
    const environments = [buildFixture("failed", "Gateway is only bound to loopback")];
    const destruction = deferred<Record<string, never>>();
    const refresh = deferred<{ environments: typeof environments }>();
    let refreshPending = false;
    const fixture = mountPage(buildMethods, {
      result: { ...snapshotListFixture(), images: [] },
      response: (method) => {
        if (method === "environments.list") {
          return refreshPending ? refresh.promise : { environments };
        }
        if (method === "environments.destroy") {
          refreshPending = true;
          return destruction.promise;
        }
        return undefined;
      },
    });
    try {
      const snapshots = await openSnapshots(fixture);
      expect(snapshots.querySelector('[role="alert"]')?.textContent).toContain(
        "Gateway is only bound to loopback",
      );
      expect(snapshots.querySelectorAll(".settings-summary dd")[3]?.textContent).toBe("1");
      button(snapshots, "Dismiss").click();
      await waitForFast(() =>
        expect(fixture.request).toHaveBeenCalledWith("environments.destroy", {
          environmentId: "build-app",
        }),
      );
      expect(snapshots.textContent).toContain("build-app");
      expect(snapshots.querySelectorAll(".settings-summary dd")[3]?.textContent).toBe("1");
      destruction.resolve({});
      await waitForFast(() => expect(snapshots.textContent).toContain("Failed build dismissed"));
      expect(vi.mocked(showConfirmDialog)).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Dismiss failed build", details: "build-app" }),
      );
      expect(snapshots.textContent).not.toContain("build-app");
      expect(snapshots.querySelectorAll(".settings-summary dd")[3]?.textContent).toBe("0");
      refresh.reject(new Error("Build inventory is unavailable"));
      await waitForFast(() =>
        expect(snapshots.textContent).toContain("Build inventory is unavailable"),
      );
      expect(snapshots.textContent).not.toContain("build-app");
      expect(snapshots.querySelectorAll(".settings-summary dd")[3]?.textContent).toBe("0");
      // The Gateway keeps terminal build records until retention; the row must stay cleared.
      refreshPending = false;
      const listed = fixture.request.mock.calls.filter(
        ([method]) => method === "environments.list",
      ).length;
      button(snapshots, "Refresh").click();
      await waitForFast(() =>
        expect(
          fixture.request.mock.calls.filter(([method]) => method === "environments.list"),
        ).toHaveLength(listed + 1),
      );
      expect(snapshots.textContent).not.toContain("build-app");
    } finally {
      destruction.resolve({});
      refresh.resolve({ environments });
      fixture.dispose();
    }
  });

  it("keeps a failed build listed when dismissal is refused or its destruction fails", async () => {
    const fixture = mountPage(buildMethods, {
      response: (method) => {
        if (method === "environments.list") {
          return { environments: [buildFixture("failed", "Setup recipe failed")] };
        }
        if (method === "environments.destroy") {
          throw new Error("Provider is unavailable");
        }
        return undefined;
      },
    });
    try {
      const snapshots = await openSnapshots(fixture);
      vi.mocked(showConfirmDialog).mockResolvedValueOnce(false);
      button(snapshots, "Dismiss").click();
      await waitForFast(() => expect(vi.mocked(showConfirmDialog)).toHaveBeenCalledTimes(1));
      expect(fixture.request).not.toHaveBeenCalledWith("environments.destroy", expect.anything());
      expect(snapshots.textContent).toContain("build-app");
      button(snapshots, "Dismiss").click();
      await waitForFast(() => expect(snapshots.textContent).toContain("Provider is unavailable"));
      expect(snapshots.textContent).toContain("build-app");
      expect(button(snapshots, "Dismiss").disabled).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it("hides build actions without advertisement and clears a pending picker on disconnect", async () => {
    const fixture = mountPage(["crabbox.images.list"]);
    try {
      const snapshots = await openSnapshots(fixture);
      expect(snapshots.textContent).not.toContain("Build snapshot");
      fixture.harness.publish(true, fixture.client, gatewayHelloForMethods(buildMethods));
      await waitForFast(() => expect(snapshots.textContent).toContain("Build snapshot"));
      await openBuild(snapshots);
      fixture.harness.publish(false, fixture.client);
      await waitForFast(() => expect(snapshots.querySelector("openclaw-modal-dialog")).toBeNull());
      expect(
        fixture.request.mock.calls.filter(([method]) => method === "environments.prepare"),
      ).toHaveLength(0);
    } finally {
      fixture.dispose();
    }
  });
});
