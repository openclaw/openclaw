/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import { createGatewayHarness, deferred } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { showToast } from "../../lib/toast.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { snapshotListFixture } from "./cloud-worker-snapshots.test-support.ts";
import "./cloud-workers-page.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));

function button(container: Element, label: string) {
  return expectDefined(
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent?.trim() === label,
    ),
    label,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(showConfirmDialog).mockResolvedValue(true);
  await i18n.setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

function mountPage(
  methods: string[],
  options: {
    result?: ReturnType<typeof snapshotListFixture>;
    config?: Record<string, unknown>;
    failMutation?: boolean;
    response?: (method: string) => unknown;
    scopes?: string[];
  } = {},
) {
  let result = options.result ?? snapshotListFixture();
  let config = options.config ?? {};
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    const response = options.response?.(method);
    if (response !== undefined) {
      return response;
    }
    if (method === "environments.list") {
      return { environments: [] };
    }
    if (method === "projects.list") {
      return {
        projects: [
          { id: "app", displayName: "App", repoRoot: "/projects/app", source: "registered" },
        ],
      };
    }
    if (method === "worktrees.list") {
      return { worktrees: [] };
    }
    if (method === "environments.prepare") {
      return { environmentId: "build-app", preparationKey: "build-key", reused: false };
    }
    if (method === "environments.destroy") {
      return {};
    }
    if (method === "config.get") {
      return {
        config,
        sourceConfig: config,
        raw: JSON.stringify(config),
        hash: "snapshot-config",
        valid: true,
        issues: [],
      };
    }
    if (method === "crabbox.images.list") {
      return result;
    }
    if (method === "config.patch") {
      config = { ...config, ...JSON.parse(String(params?.raw)) };
      return { ok: true, config, hash: "snapshot-config-updated" };
    }
    if (
      ["crabbox.images.pin", "crabbox.images.delete", "crabbox.images.rollback"].includes(method)
    ) {
      if (options.failMutation) {
        throw new Error("Provider is unavailable");
      }
      if (method === "crabbox.images.delete") {
        result = {
          ...result,
          images: result.images.filter((image) => image.checkpointId !== params?.checkpointId),
        };
        return { status: "deleted" };
      }
      result = {
        ...result,
        images: result.images.map((image) =>
          image.checkpointId === params?.checkpointId
            ? { ...image, pinned: params?.pinned ? { atMs: 1234 } : undefined }
            : image,
        ),
      };
      return result.images.find((image) => image.checkpointId === params?.checkpointId);
    }
    throw new Error(`Unexpected request ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const harness = createGatewayHarness(client);
  harness.publish(true, client, gatewayHelloForMethods(methods, options.scopes));
  const runtimeConfig = createRuntimeConfigCapability(harness.gateway);
  const context = {
    gateway: harness.gateway,
    runtimeConfig,
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-cloud-workers-page");
  provider.append(page);
  document.body.append(provider);
  return {
    page,
    request,
    harness,
    client,
    dispose: () => {
      provider.remove();
      runtimeConfig.dispose();
    },
  };
}

describe("Cloud worker snapshots", () => {
  it("keeps the segment discoverable without calling an unadvertised plugin method", async () => {
    const fixture = mountPage([]);
    try {
      await waitForFast(() =>
        expect(fixture.page.textContent).toContain("No cloud worker profiles"),
      );
      button(fixture.page, "Snapshots").click();
      await waitForFast(() =>
        expect(fixture.page.textContent).toContain(
          "Snapshots are available when the Crabbox worker provider is enabled and the Gateway advertises them.",
        ),
      );
      expect(
        [...fixture.page.querySelectorAll("button")].some(
          (entry) => entry.textContent?.trim() === "Refresh",
        ),
      ).toBe(false);
      expect(fixture.request).not.toHaveBeenCalledWith("crabbox.images.list", expect.anything());
    } finally {
      fixture.dispose();
    }
  });

  it("loads on entry, groups old and current records, and refreshes only on request", async () => {
    const fixture = mountPage(["crabbox.images.list", "crabbox.images.recover"]);
    try {
      await waitForFast(() =>
        expect(fixture.page.textContent).toContain("No cloud worker profiles"),
      );
      expect(fixture.request).not.toHaveBeenCalledWith("crabbox.images.list", expect.anything());
      button(fixture.page, "Snapshots").click();
      await waitForFast(() => expect(fixture.page.textContent).toContain("github.com/acme/app"));
      const snapshots = expectDefined(
        fixture.page.querySelector("openclaw-cloud-worker-snapshots"),
        "Snapshots view",
      );
      const groups = [...snapshots.querySelectorAll(".settings-section")];
      const build = expectDefined(
        groups.find((group) => group.querySelector("h2")?.textContent?.includes("linux-build")),
        "Build group",
      );
      expect(build.textContent).toContain("aws · standard, burst · linux · Warm images on");
      expect(build.querySelectorAll(".settings-row")).toHaveLength(2);
      const projectRow = expectDefined(
        [...build.querySelectorAll(".settings-row")].find((row) =>
          row.textContent?.includes("github.com/acme/app"),
        ),
        "Project snapshot with pending predecessor deletion",
      );
      expect(projectRow.textContent).toContain("Available");
      expect(projectRow.textContent).toContain("Checkpoint deletion pending");
      expect(projectRow.textContent).toContain("image-app-predecessor");
      expect(projectRow.textContent).toContain(
        "Cleanup retries during the next warm-image capture or worker teardown.",
      );
      expect(projectRow.querySelector("button")).toBeNull();
      const retiringRow = expectDefined(
        [...snapshots.querySelectorAll(".settings-row")].find((row) =>
          row.textContent?.includes("github.com/acme/retiring"),
        ),
        "Snapshot awaiting deletion",
      );
      expect(retiringRow.textContent).toContain("Retiring");
      expect(retiringRow.textContent).toContain("Checkpoint deletion pending");
      expect(retiringRow.textContent).toContain("image-retiring");
      expect(retiringRow.textContent).not.toContain("Available");
      expect(retiringRow.querySelector("button")).toBeNull();
      expect(build.textContent).toContain("Building: creating");
      expect(build.textContent).toContain("Machine image");
      const machineRow = expectDefined(
        [...build.querySelectorAll(".settings-row")].find((row) =>
          row.textContent?.includes("Machine image"),
        ),
        "Machine snapshot row",
      );
      expect(machineRow.textContent).toContain("aws · burst");
      expect(machineRow.textContent).not.toContain("Created");
      expect(machineRow.textContent).not.toContain("Last used");
      expect(machineRow.textContent).not.toContain("Runtime:");
      for (const row of snapshots.querySelectorAll(".settings-row")) {
        expect(row.textContent).not.toContain("Unlabeled");
      }
      expect(build.textContent).toContain("Commit: 01234567");
      expect(build.textContent).toContain("Allocations: 21");
      expect(build.textContent).toContain("Runtime: abcdef012345");
      expect(snapshots.textContent).toContain("Unlabeled profile");
      expect(snapshots.textContent).toContain("Project image");
      const cold = expectDefined(
        groups.find((group) => group.querySelector("h2")?.textContent?.includes("cold-build")),
        "Configured profile without snapshots",
      );
      expect(cold.textContent).toContain("aws · standard · linux · Warm images off");
      expect(cold.textContent).not.toContain("Unlabeled");
      const classless = expectDefined(
        groups.find((group) => group.querySelector("h2")?.textContent?.includes("classless-build")),
        "Configured profile without a class",
      );
      expect(classless.textContent).toContain("aws · linux · Warm images off");
      expect(classless.textContent).not.toContain("Unlabeled");
      expect(snapshots.textContent).toContain("Needs migration");
      expect(snapshots.textContent).toContain("openclaw doctor --fix");
      expect(
        [...snapshots.querySelectorAll(".settings-summary dd")].map((entry) => entry.textContent),
      ).toEqual(["2", "1", "1", "4"]);
      expect(
        [...snapshots.querySelectorAll("button")].filter(
          (entry) => entry.textContent?.trim() === "Recover",
        ),
      ).toHaveLength(1);
      button(snapshots, "Refresh").click();
      await waitForFast(() =>
        expect(
          fixture.request.mock.calls.filter(([method]) => method === "crabbox.images.list"),
        ).toHaveLength(2),
      );
    } finally {
      fixture.dispose();
    }
  });

  it("gates each mutation independently and explains deletion protection", async () => {
    const result = snapshotListFixture();
    result.images = result.images.map((image) => ({
      ...image,
      checkpointId: image.checkpointId ?? image.profileKey,
    }));
    result.images.push({
      ...expectDefined(result.images[1], "Retiring image"),
      profileKey: "pinned",
      projectLabel: "pinned",
      retirement: undefined,
      held: false,
      pinned: { atMs: 1234 },
      previous: { checkpointId: "previous-pinned", createdAtMs: 1234 },
    });
    const fixture = mountPage(["crabbox.images.list", "crabbox.images.delete"], { result });
    try {
      await waitForFast(() =>
        expect(fixture.page.textContent).toContain("No cloud worker profiles"),
      );
      button(fixture.page, "Snapshots").click();
      await waitForFast(() => expect(fixture.page.textContent).toContain("github.com/acme/app"));
      const deletes = [...fixture.page.querySelectorAll<HTMLButtonElement>("button")].filter(
        (entry) => entry.textContent?.trim() === "Delete",
      );
      expect(deletes.map((entry) => [entry.disabled, entry.title])).toEqual([
        [true, "Outstanding allocations still hold this snapshot."],
        [true, "Wait for the active capture to finish before deleting this snapshot."],
        [false, ""],
        [true, "Unpin this snapshot before deleting it."],
        [true, "Wait for the active capture to finish before deleting this snapshot."],
      ]);
      expect(
        [...fixture.page.querySelectorAll("button")].some((entry) =>
          ["Pin", "Unpin", "Roll back"].includes(entry.textContent?.trim() ?? ""),
        ),
      ).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it("pins immediately, reloads the row, and confirms deletion after unpinning", async () => {
    const result = snapshotListFixture();
    result.images = [
      { ...expectDefined(result.images[0], "Project image"), held: false, retirement: undefined },
    ];
    const fixture = mountPage(
      ["crabbox.images.list", "crabbox.images.pin", "crabbox.images.delete"],
      { result },
    );
    try {
      await waitForFast(() =>
        expect(fixture.page.textContent).toContain("No cloud worker profiles"),
      );
      button(fixture.page, "Snapshots").click();
      await waitForFast(() => expect(fixture.page.textContent).toContain("github.com/acme/app"));
      button(fixture.page, "Pin").click();
      await waitForFast(() =>
        expect(fixture.request).toHaveBeenCalledWith("crabbox.images.pin", {
          checkpointId: "image-app",
          pinned: true,
        }),
      );
      await waitForFast(() => expect(button(fixture.page, "Unpin").disabled).toBe(false));
      expect(showConfirmDialog).not.toHaveBeenCalled();
      expect(button(fixture.page, "Delete").disabled).toBe(true);
      button(fixture.page, "Unpin").click();
      await waitForFast(() => expect(button(fixture.page, "Delete").disabled).toBe(false));
      button(fixture.page, "Delete").click();
      await waitForFast(() =>
        expect(fixture.request).toHaveBeenCalledWith("crabbox.images.delete", {
          checkpointId: "image-app",
        }),
      );
      expect(showConfirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Delete snapshot", danger: true }),
      );
      await waitForFast(() =>
        expect(fixture.page.textContent).not.toContain("github.com/acme/app"),
      );
    } finally {
      fixture.dispose();
    }
  });

  it("shows pin failures in a toast and keeps the image unchanged", async () => {
    const result = snapshotListFixture();
    result.images = [
      { ...expectDefined(result.images[0], "Project image"), held: false, retirement: undefined },
    ];
    const fixture = mountPage(["crabbox.images.list", "crabbox.images.pin"], {
      result,
      failMutation: true,
    });
    try {
      await waitForFast(() =>
        expect(fixture.page.textContent).toContain("No cloud worker profiles"),
      );
      button(fixture.page, "Snapshots").click();
      await waitForFast(() => expect(fixture.page.textContent).toContain("github.com/acme/app"));
      button(fixture.page, "Pin").click();
      await waitForFast(() =>
        expect(showToast).toHaveBeenCalledWith({ message: "Provider is unavailable" }),
      );
      expect(fixture.page.textContent).toContain("github.com/acme/app");
    } finally {
      fixture.dispose();
    }
  });

  it("confirms rollback using the previous checkpoint and permits unpinning it", async () => {
    const result = snapshotListFixture();
    result.images = [
      {
        ...expectDefined(result.images[0], "Project image"),
        held: false,
        retirement: undefined,
        previous: { checkpointId: "image-previous", createdAtMs: 1234, pinned: { atMs: 1234 } },
      },
    ];
    const fixture = mountPage(
      ["crabbox.images.list", "crabbox.images.rollback", "crabbox.images.pin"],
      { result },
    );
    try {
      await waitForFast(() =>
        expect(fixture.page.textContent).toContain("No cloud worker profiles"),
      );
      button(fixture.page, "Snapshots").click();
      await waitForFast(() => expect(fixture.page.textContent).toContain("image-previous"));
      button(fixture.page, "Unpin").click();
      await waitForFast(() =>
        expect(fixture.request).toHaveBeenCalledWith("crabbox.images.pin", {
          checkpointId: "image-previous",
          pinned: false,
        }),
      );
      await waitForFast(() => expect(button(fixture.page, "Roll back").disabled).toBe(false));
      button(fixture.page, "Roll back").click();
      await waitForFast(() =>
        expect(fixture.request).toHaveBeenCalledWith("crabbox.images.rollback", {
          checkpointId: "image-previous",
        }),
      );
      expect(showConfirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Roll back snapshot", details: "image-previous" }),
      );
    } finally {
      fixture.dispose();
    }
  });

  it("validates retention minima and patches only the plugin-owned policy", async () => {
    const fixture = mountPage(["crabbox.images.list", "config.patch"]);
    try {
      await waitForFast(() =>
        expect(fixture.page.textContent).toContain("No cloud worker profiles"),
      );
      button(fixture.page, "Snapshots").click();
      await waitForFast(() => expect(fixture.page.textContent).toContain("Retention policy"));
      const set = (label: string, value: string) => {
        const input = expectDefined(
          fixture.page.querySelector<HTMLInputElement | HTMLSelectElement>(
            `[aria-label="${label}"]`,
          ),
          label,
        );
        input.value = value;
        input.dispatchEvent(
          new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
        );
      };
      const save = () => button(fixture.page, "Save retention policy").click();
      expect(
        fixture.page.querySelector<HTMLInputElement>('[aria-label="Refresh after"]')?.value,
      ).toBe("24h");
      expect(
        fixture.page.querySelector<HTMLInputElement>('[aria-label="Retain unused"]')?.value,
      ).toBe("14d");
      set("Refresh after", "59m");
      save();
      await waitForFast(() =>
        expect(fixture.page.textContent).toContain("Enter a duration of at least 1h"),
      );
      set("Refresh after", "90m");
      set("Retain unused", "23h");
      save();
      await waitForFast(() =>
        expect(fixture.page.textContent).toContain("Enter a duration of at least 1d"),
      );
      expect(fixture.request).not.toHaveBeenCalledWith("config.patch", expect.anything());
      set("Retain unused", "2d");
      set("Previous generations", "1");
      save();
      await waitForFast(() =>
        expect(fixture.request).toHaveBeenCalledWith(
          "config.patch",
          expect.objectContaining({ raw: expect.any(String) }),
        ),
      );
      const params = expectDefined(
        fixture.request.mock.calls.find(([method]) => method === "config.patch")?.[1],
        "Config patch",
      );
      expect(JSON.parse(String(params.raw))).toEqual({
        plugins: {
          entries: {
            crabbox: {
              config: { warmImages: { refreshAfter: "90m", retainUnused: "2d", keepPrevious: 1 } },
            },
          },
        },
      });
      await waitForFast(() =>
        expect(fixture.page.textContent).toContain(
          "Retention policy saved. Restart the Gateway to apply it.",
        ),
      );
    } finally {
      fixture.dispose();
    }
  });
});

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
