/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
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
const methods = ["environments.list", "crabbox.images.list", "config.patch"];
function sheet(page: Element) {
  return expectDefined(page.querySelector(".cloud-environments__sheet"), "Environment sheet");
}
function input(page: Element, label: string) {
  return expectDefined(page.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`), label);
}
function changeInput(element: HTMLInputElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

describe("Cloud environments", () => {
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
    const ready = {
      ...buildEnvironmentFixture("ready"),
      id: "ready",
      preparation: {
        ...buildEnvironmentFixture().preparation,
        details: {
          ...buildEnvironmentFixture().preparation.details,
          project: { label: "github.com/acme/ready", baseCommit: "abcdef" },
        },
      },
    };
    const fixture = mountPage(methods, {
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
    try {
      await waitForSolid(() =>
        expect(fixture.page.querySelectorAll(".cloud-environments__row")).toHaveLength(4),
      );
      const rows = [...fixture.page.querySelectorAll(".cloud-environments__row")];
      expect(rows.map((row) => row.textContent)).toEqual([
        "github.com/acme/appBuilding",
        "github.com/acme/coldCold only",
        "github.com/acme/pausedNeeds attention",
        expect.stringContaining("github.com/acme/readyReady ·"),
      ]);
      expect(rows.every((row) => row.children.length === 2)).toBe(true);
      expect(sheet(fixture.page).textContent).toContain("01234567");
      expect(
        [...sheet(fixture.page).querySelectorAll(".cloud-environments__snapshot")].map((row) =>
          row.getAttribute("aria-label"),
        ),
      ).toEqual(["linux-build", "arm-build"]);
      expect(
        sheet(fixture.page).querySelector(".cloud-environments__machine > span")?.textContent,
      ).toBe("aws · standard · linux");
      expect(sheet(fixture.page).textContent).not.toContain("Paused: uncertain");
      expect(fixture.page.querySelector(".settings-segmented")).toBeNull();
      expect(fixture.page.querySelector("details")?.open).toBe(false);
      (rows[2] as HTMLButtonElement).click();
      flush();
      await waitForSolid(() =>
        expect(sheet(fixture.page).textContent).toContain("Paused: uncertain"),
      );
      expect(button(sheet(fixture.page), "Rebuild").disabled).toBe(true);
      expect(sheet(fixture.page).textContent).not.toContain("01234567");
      expect(fixture.request).toHaveBeenCalledWith("environments.list", {
        includePreparedDetails: true,
      });
    } finally {
      fixture.dispose();
    }
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
      const fixture = mountPage(methods, { result });
      try {
        await waitForSolid(() =>
          expect(sheet(fixture.page).textContent).toContain("Dev Container"),
        );
        expect(fixture.page.querySelector(".cloud-environments__row")?.textContent).toBe(
          "github.com/acme/appNeeds attention",
        );
        expect(
          sheet(fixture.page).querySelector(".cloud-environments__step--longest")?.textContent,
        ).toContain("updateContentCommand");
        expect(sheet(fixture.page).querySelector(".cloud-environments__output")?.textContent).toBe(
          "synthetic package unavailable",
        );
        if (newerSuccessfulProfile) {
          expect(sheet(fixture.page).querySelector('[role="alert"]')?.textContent).toContain(
            "linux-build",
          );
        }
        expect(sheet(fixture.page).textContent).not.toContain("MB");
        expect(sheet(fixture.page).textContent).not.toContain("Install dependencies");
      } finally {
        fixture.dispose();
      }
    },
  );

  it("shows configured repositories without calling an unadvertised snapshot plugin", async () => {
    const fixture = mountPage(["environments.list"], {
      config: { cloudWorkers: { projectProfiles: { "github.com/acme/app": "linux" } } },
    });
    try {
      await waitForSolid(() =>
        expect(fixture.page.querySelector(".cloud-environments__row")?.textContent).toBe(
          "github.com/acme/appCold only",
        ),
      );
      expect(fixture.request).not.toHaveBeenCalledWith("crabbox.images.list", expect.anything());
      expect(button(sheet(fixture.page), "Rebuild").disabled).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    { current: "linux-build", next: "large" },
    { current: undefined, next: "linux-build" },
  ])(
    "saves repository default $current → $next without replacing other defaults",
    async ({ current, next }) => {
      const fixture = mountPage(methods, {
        config: {
          cloudWorkers: {
            profiles: {
              "linux-build": {
                provider: "crabbox",
                settings: { provider: "aws", class: "standard" },
              },
              ...(current
                ? { large: { provider: "crabbox", settings: { provider: "aws", class: "large" } } }
                : {}),
            },
            projectProfiles: {
              ...(current ? { "github.com/acme/app": current } : {}),
              "github.com/acme/other": "linux-build",
            },
          },
        },
      });
      try {
        await waitForSolid(() =>
          expect(button(sheet(fixture.page), "Change").disabled).toBe(false),
        );
        button(sheet(fixture.page), "Change").click();
        flush();
        const select = expectDefined(
          sheet(fixture.page).querySelector<HTMLSelectElement>(
            'select[aria-label="Default profile"]',
          ),
          "Default profile selector",
        );
        expect(select.value).toBe(current ?? "");
        select.value = next;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        flush();
        await waitForSolid(() =>
          expect(fixture.request.mock.calls.some(([method]) => method === "config.patch")).toBe(
            true,
          ),
        );
        const patch = expectDefined(
          fixture.request.mock.calls.find(([method]) => method === "config.patch"),
          "Config patch request",
        )[1];
        expect(JSON.parse(String(patch?.raw))).toEqual({
          cloudWorkers: { projectProfiles: { "github.com/acme/app": next } },
        });
        expect(patch?.baseHash).toBe("snapshot-config");
      } finally {
        fixture.dispose();
      }
    },
  );

  it("validates retention minima and patches only the shared plugin policy", async () => {
    const fixture = mountPage(methods);
    try {
      await waitForSolid(() => expect(input(fixture.page, "Refresh after").disabled).toBe(false));
      expect(
        fixture.page.querySelector('.cloud-environments__sheet input[aria-label="Refresh after"]'),
      ).toBeNull();
      changeInput(input(fixture.page, "Refresh after"), "30m");
      button(fixture.page, "Save retention policy").click();
      flush();
      await waitForSolid(() =>
        expect(fixture.page.textContent).toContain("Enter a duration of at least 1h"),
      );
      expect(fixture.request.mock.calls.some(([method]) => method === "config.patch")).toBe(false);
      changeInput(input(fixture.page, "Refresh after"), "2h");
      changeInput(input(fixture.page, "Retain unused"), "3d");
      button(fixture.page, "Save retention policy").click();
      flush();
      await waitForSolid(() =>
        expect(fixture.request.mock.calls.some(([method]) => method === "config.patch")).toBe(true),
      );
      const patch = expectDefined(
        fixture.request.mock.calls.find(([method]) => method === "config.patch"),
        "Config patch request",
      )[1];
      expect(JSON.parse(String(patch?.raw))).toEqual({
        plugins: {
          entries: {
            crabbox: {
              config: { warmImages: { refreshAfter: "2h", retainUnused: "3d", keepPrevious: 0 } },
            },
          },
        },
      });
    } finally {
      fixture.dispose();
    }
  });

  it("counts only usable pool workers and keeps capacity editable in Advanced", async () => {
    const ready = { ...buildEnvironmentFixture("ready"), status: "available" };
    const inventory = [
      ready,
      { ...ready, status: "unavailable" },
      { ...ready, status: "error" },
      { ...ready, status: "stopping" },
      {
        ...ready,
        preparation: {
          ...ready.preparation,
          details: { ...ready.preparation.details, expiresAtMs: Date.now() - 1 },
        },
      },
      {
        ...ready,
        preparation: {
          ...ready.preparation,
          details: { ...ready.preparation.details, consumedAtMs: Date.now() },
        },
      },
      { ...ready, preparation: { ...ready.preparation, details: undefined } },
      { ...ready, worker: { ...ready.worker, destroyRequestedAtMs: Date.now() } },
      { ...ready, worker: { ...ready.worker, attachedSessionIds: ["active-session"] } },
    ];
    for (const [index, environment] of inventory.entries()) {
      environment.id = `pool-${index}`;
    }
    const fixture = mountPage(methods, {
      response: (method, params) =>
        method === "environments.list" && params?.includePreparedDetails
          ? { environments: inventory, profiles: [] }
          : undefined,
    });
    try {
      await waitForSolid(() => expect(input(fixture.page, "Pool cap").disabled).toBe(false));
      await waitForSolid(() =>
        expect(fixture.page.textContent).toContain("1 ready workers · Pool cap"),
      );
      changeInput(input(fixture.page, "Pool cap"), "6");
      button(fixture.page, "Save pool").click();
      flush();
      await waitForSolid(() =>
        expect(fixture.request.mock.calls.some(([method]) => method === "config.patch")).toBe(true),
      );
      const patch = expectDefined(
        fixture.request.mock.calls.find(([method]) => method === "config.patch"),
        "Config patch request",
      )[1];
      expect(JSON.parse(String(patch?.raw))).toEqual({
        cloudWorkers: { preparedPool: { maxTotal: 6 } },
      });
    } finally {
      fixture.dispose();
    }
  });
});
