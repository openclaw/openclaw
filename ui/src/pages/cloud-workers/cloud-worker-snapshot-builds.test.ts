/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
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
vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));
setupSnapshotsDomSuite();
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
    {
      ...expectDefined(result.images[0], "App snapshot"),
      held: false,
      retirement: undefined,
      projectRoot: "/projects/app",
    },
  ];
  return result;
}
function sheet(page: Element) {
  return expectDefined(page.querySelector(".cloud-environments__sheet"), "Environment sheet");
}

describe("Cloud environment builds", () => {
  it("rebuilds the selected local repository and shows capacity failures", async () => {
    const fixture = mountPage(methods, {
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
    try {
      await waitForSolid(() => expect(button(sheet(fixture.page), "Rebuild").disabled).toBe(false));
      button(sheet(fixture.page), "Rebuild").click();
      flush();
      await waitForSolid(() =>
        expect(fixture.page.textContent).toContain("The prepared worker pool is full"),
      );
      expect(fixture.request).toHaveBeenCalledWith("environments.prepare", {
        profileId: "linux-build",
        projectPath: "/projects/app",
      });
    } finally {
      fixture.dispose();
    }
  });
  it("refreshes rebuild eligibility after a machine configuration save", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let enabled = false;
    const configuration = () => ({
      cloudWorkers: {
        profiles: {
          "linux-build": {
            provider: "crabbox",
            settings: {
              provider: "aws",
              class: "standard",
              target: "linux",
              warmImage: enabled,
            },
          },
        },
      },
    });
    const fixture = mountPage([...methods, "config.patch"], {
      response: (method, params) => {
        if (method === "config.get") {
          const config = configuration();
          const hash = enabled ? "enabled" : "disabled";
          return {
            config,
            sourceConfig: config,
            raw: JSON.stringify(config),
            hash,
            appliedConfigHash: hash,
            valid: true,
            issues: [],
          };
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
    try {
      await waitForSolid(() => expect(sheet(fixture.page).textContent).toContain("01234567"));
      expect(button(sheet(fixture.page), "Rebuild").disabled).toBe(true);
      button(fixture.page, "Edit").click();
      flush();
      const warmImages = expectDefined(
        fixture.page.querySelector<HTMLSelectElement>('select[aria-label="Warm images"]'),
        "Warm image selector",
      );
      warmImages.value = "on";
      warmImages.dispatchEvent(new Event("change", { bubbles: true }));
      flush();
      button(fixture.page, "Save").click();
      await waitForSolid(() =>
        expect(fixture.page.querySelector('select[aria-label="Warm images"]')).toBeNull(),
      );
      await vi.advanceTimersByTimeAsync(250);
      flush();
      await waitForSolid(() => expect(button(sheet(fixture.page), "Rebuild").disabled).toBe(false));
      button(sheet(fixture.page), "Rebuild").click();
      await waitForSolid(() =>
        expect(fixture.request).toHaveBeenCalledWith("environments.prepare", {
          profileId: "linux-build",
          projectPath: "/projects/app",
        }),
      );
    } finally {
      fixture.dispose();
    }
  });

  it("keeps unlabeled builds inspectable and actionable in Advanced", async () => {
    const pending = buildEnvironmentFixture();
    const failed = buildEnvironmentFixture("failed", "Unlabeled setup failed");
    let workers = [
      {
        ...pending,
        id: "unlabeled-pending",
        preparation: { ...pending.preparation, details: undefined },
      },
      {
        ...failed,
        id: "unlabeled-failed",
        preparation: {
          ...failed.preparation,
          details: { ...failed.preparation.details, project: { baseCommit: "abcdef" } },
        },
      },
    ];
    const fixture = mountPage(methods, {
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
    try {
      const advanced = expectDefined(
        fixture.page.querySelector(".cloud-environments__advanced"),
        "Advanced",
      );
      await waitForSolid(() => expect(advanced.textContent).toContain("Unlabeled setup failed"));
      expect(fixture.page.querySelectorAll(".cloud-environments__row")).toHaveLength(0);
      button(advanced, "Cancel").click();
      await waitForSolid(() =>
        expect(fixture.request).toHaveBeenCalledWith("environments.destroy", {
          environmentId: "unlabeled-pending",
        }),
      );
      await waitForSolid(() => expect(button(advanced, "Dismiss").disabled).toBe(false));
      button(advanced, "Dismiss").click();
      await waitForSolid(() =>
        expect(fixture.request).toHaveBeenCalledWith("environments.destroy", {
          environmentId: "unlabeled-failed",
        }),
      );
      await waitForSolid(() =>
        expect(advanced.textContent).not.toContain("Unlabeled setup failed"),
      );
    } finally {
      fixture.dispose();
    }
  });

  it.each([true, false])(
    "keeps ready-worker cleanup failures actionable (repository label: %s)",
    async (labeled) => {
      const ready = buildEnvironmentFixture("ready", "Provider cleanup failed");
      const worker = {
        ...ready,
        status: "error",
        worker: { ...ready.worker, destroyRequestedAtMs: Date.now() },
        preparation: {
          ...ready.preparation,
          details: {
            ...ready.preparation.details,
            project: { baseCommit: "abcdef", ...(labeled ? { label: "github.com/acme/app" } : {}) },
          },
        },
      };
      const fixture = mountPage(methods, {
        result: { ...localSnapshot(), images: [], legacyLeases: [] },
        response: (method, params) =>
          method === "environments.list" && params?.includePreparedDetails
            ? { environments: [worker], profiles: [] }
            : undefined,
      });
      try {
        await waitForSolid(() =>
          expect(fixture.page.textContent).toContain("Provider cleanup failed"),
        );
        const surface = labeled
          ? sheet(fixture.page)
          : expectDefined(fixture.page.querySelector(".cloud-environments__advanced"), "Advanced");
        expect(surface.textContent).toContain("Needs attention");
        button(surface, "Cancel").click();
        await waitForSolid(() =>
          expect(fixture.request).toHaveBeenCalledWith("environments.destroy", {
            environmentId: "build-app",
          }),
        );
      } finally {
        fixture.dispose();
      }
    },
  );

  it("fences recovery when the connection changes during confirmation", async () => {
    const result = localSnapshot();
    result.images[0]!.capture = { selector: "capture-app", phase: "uncertain", stale: false };
    const fixture = mountPage(methods, {
      result,
      response: (method, params) =>
        method === "environments.list" && params?.includePreparedDetails
          ? { environments: [buildEnvironmentFixture()], profiles: [] }
          : undefined,
    });
    const confirmation = createDeferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValue(confirmation.promise);
    try {
      await waitForSolid(() =>
        expect(sheet(fixture.page).textContent).toContain("Paused: uncertain"),
      );
      button(sheet(fixture.page), "Recover").click();
      flush();
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
    } finally {
      fixture.dispose();
    }
  });
  it("dismisses a failed build immediately even when its inventory refresh fails", async () => {
    let dismissed = false;
    const fixture = mountPage(methods, {
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
    try {
      await waitForSolid(() => expect(sheet(fixture.page).textContent).toContain("Setup failed"));
      expect(fixture.page.querySelector(".cloud-environments__row")?.textContent).toBe(
        "github.com/acme/appNeeds attention",
      );
      button(sheet(fixture.page), "Dismiss").click();
      flush();
      await waitForSolid(() => expect(fixture.page.textContent).toContain("Inventory unavailable"));
      expect(sheet(fixture.page).textContent).not.toContain("Setup failed");
      expect(fixture.request).toHaveBeenCalledWith("environments.destroy", {
        environmentId: "build-app",
      });
    } finally {
      fixture.dispose();
    }
  });
  it("polls automatic preparation through worker readiness before reading the published snapshot", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let ready = false;
    let consumed = false;
    const build = buildEnvironmentFixture();
    build.preparation.purpose = "reserve";
    const result = localSnapshot();
    result.images = [];
    const fixture = mountPage(methods, {
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
    try {
      await vi.advanceTimersByTimeAsync(0);
      flush();
      expect(fixture.page.querySelector(".cloud-environments__row")?.textContent).toBe(
        "github.com/acme/appBuilding",
      );
      ready = true;
      await vi.advanceTimersByTimeAsync(10_000);
      flush();
      expect(fixture.page.querySelector(".cloud-environments__row")?.textContent).toContain(
        "Ready ·",
      );
      consumed = true;
      await vi.advanceTimersByTimeAsync(10_000);
      flush();
      const count = fixture.request.mock.calls.filter(
        ([method, params]) => method === "environments.list" && params?.includePreparedDetails,
      ).length;
      await vi.advanceTimersByTimeAsync(30_000);
      flush();
      expect(
        fixture.request.mock.calls.filter(
          ([method, params]) => method === "environments.list" && params?.includePreparedDetails,
        ),
      ).toHaveLength(count);
    } finally {
      fixture.dispose();
    }
  });
});
