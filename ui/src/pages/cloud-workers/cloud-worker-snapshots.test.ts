/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { snapshotListFixture } from "./cloud-worker-snapshots.test-support.ts";
import "./cloud-workers-page.ts";

function button(container: Element, label: string) {
  return expectDefined(
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent?.trim() === label,
    ),
    label,
  );
}

beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
});

function mountPage(methods: string[]) {
  const request = vi.fn(async (method: string) => {
    if (method === "config.get") {
      return {
        config: {},
        sourceConfig: {},
        raw: "{}",
        hash: "snapshot-config",
        valid: true,
        issues: [],
      };
    }
    if (method === "crabbox.images.list") {
      return snapshotListFixture();
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
      expect(build.textContent).toContain("Available");
      expect(build.textContent).toContain("Building: creating");
      expect(build.textContent).toContain("Machine image");
      const machineRow = expectDefined(
        [...build.querySelectorAll(".settings-row")].find((row) =>
          row.textContent?.includes("Machine image"),
        ),
        "Machine snapshot row",
      );
      expect(machineRow.textContent).toContain("aws · burst · linux");
      expect(build.textContent).toContain("Commit: 01234567");
      expect(build.textContent).toContain("Allocations: 21");
      expect(build.textContent).toContain("Runtime: abcdef012345");
      expect(snapshots.textContent).toContain("Unlabeled profile");
      expect(snapshots.textContent).toContain("Created Unlabeled");
      expect(snapshots.textContent).toContain("Warm images off");
      expect(snapshots.textContent).toContain("Needs migration");
      expect(snapshots.textContent).toContain("openclaw doctor --fix");
      expect(
        [...snapshots.querySelectorAll(".settings-summary dd")].map((entry) => entry.textContent),
      ).toEqual(["1", "1", "1", "2"]);
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
});
