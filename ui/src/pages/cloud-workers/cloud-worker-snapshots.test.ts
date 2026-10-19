/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
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

describe("Cloud environments", () => {
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
    const result = snapshotListFixture();
    result.images = [
      {
        ...expectDefined(result.images[0], "App snapshot"),
        held: false,
        retirement: undefined,
        projectRoot: "/projects/app",
      },
      {
        ...expectDefined(result.images[2], "Uncertain snapshot"),
        projectLabel: "github.com/acme/paused",
      },
    ];
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
    const { page, request } = mountTestPage(methods, {
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
    expect(rows.every((row) => row.children.length === 2)).toBe(true);
    expect(sheet(page).textContent).toContain("01234567");
    expect(
      [...sheet(page).querySelectorAll(".cloud-environments__snapshot")].map((row) =>
        row.getAttribute("aria-label"),
      ),
    ).toEqual(["linux-build", "arm-build"]);
    expect(sheet(page).querySelector(".cloud-environments__machine > span")?.textContent).toBe(
      "aws · standard · linux",
    );
    expect(sheet(page).textContent).not.toContain("Paused: uncertain");
    expect(page.querySelector(".settings-segmented")).toBeNull();
    expect(page.querySelector("details")?.open).toBe(false);
    (rows[2] as HTMLButtonElement).click();
    flush();
    await waitText(() => sheet(page), "Paused: uncertain");
    expect(button(sheet(page), "Rebuild").disabled).toBe(true);
    expect(sheet(page).textContent).not.toContain("01234567");
    expect(request).toHaveBeenCalledWith("environments.list", {
      includePreparedDetails: true,
    });
  });

  it.each([false, true])(
    "renders recorded setup phases and failures with a newer successful profile: %s",
    async (newerSuccessfulProfile) => {
      const result = snapshotListFixture();
      result.images = [
        {
          ...expectDefined(result.images[0], "App snapshot"),
          held: false,
          retirement: undefined,
          recipePreparation: {
            source: "devcontainer",
            phaseDurationsMs: { onCreate: 1200, updateContent: 6400 },
            failure: {
              reason: "Dependency installation failed",
              outputTail: "synthetic package unavailable",
            },
          },
          recipePreparationAtMs: 1000,
        },
      ];
      if (newerSuccessfulProfile) {
        result.images.push({
          ...expectDefined(result.images[0], "Failed snapshot"),
          profileKey: "large-profile",
          profileId: "large",
          recipePreparation: {
            source: "devcontainer",
            phaseDurationsMs: { onCreate: 1200, updateContent: 6400 },
          },
          recipePreparationAtMs: 2000,
        });
      }
      const { page } = mountTestPage(methods, { result });
      await waitText(() => sheet(page), "Dev Container");
      expect(page.querySelector(".cloud-environments__row")?.textContent).toBe(
        "github.com/acme/appNeeds attention",
      );
      expect(
        sheet(page).querySelector(".cloud-environments__step--longest")?.textContent,
      ).toContain("updateContentCommand");
      expect(sheet(page).querySelector(".cloud-environments__output")?.textContent).toBe(
        "synthetic package unavailable",
      );
      if (newerSuccessfulProfile) {
        expect(sheet(page).querySelector('[role="alert"]')?.textContent).toContain("linux-build");
      }
      expect(sheet(page).textContent).not.toContain("MB");
      expect(sheet(page).textContent).not.toContain("Install dependencies");
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

  it("validates retention minima and patches only the shared plugin policy", async () => {
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
    click(page, "Save retention policy");
    const patch = await configPatch(request);
    expect(JSON.parse(String(patch?.raw))).toEqual({
      plugins: {
        entries: {
          crabbox: {
            config: { warmImages: { refreshAfter: "2h", retainUnused: "3d", keepPrevious: 0 } },
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
