/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
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
});

function mountPage(
  methods: string[],
  options: {
    result?: ReturnType<typeof snapshotListFixture>;
    config?: Record<string, unknown>;
    failMutation?: boolean;
  } = {},
) {
  let result = options.result ?? snapshotListFixture();
  let config = options.config ?? {};
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
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
  harness.publish(true, client, gatewayHelloForMethods(methods));
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
