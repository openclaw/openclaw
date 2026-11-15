import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPackageReleasePrefixFixture } from "../../infra/package-release-slot.test-support.js";
import { createNpmTarget } from "../../infra/package-update-steps.test-support.js";
import { inspectNpmGlobalDestination } from "./update-command-package-destination.js";
import * as servicePlan from "./update-command-service-plan.js";

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-destination-release-")));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The managed service as the service manager reports it: a loaded, running user unit. */
function serviceStarting(
  entrypoint: string,
  definition: { kind: "writable" } | { kind: "sealed"; reason: "inspection-failed" } = {
    kind: "writable",
  },
) {
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(entrypoint, "", { flag: "a" });
  vi.spyOn(servicePlan, "isGatewayServiceManagementAllowedForUpdate").mockReturnValue(true);
  vi.spyOn(servicePlan, "readManagedGatewayServiceForUpdate").mockResolvedValue({
    // A Node service; Bun-run services are never refreshed in place.
    command: { programArguments: ["/usr/bin/node", entrypoint, "gateway", "--port", "18789"] },
    env: {},
    installed: true,
    running: true,
    loadState: { status: "loaded" },
    runtime: { status: "running", systemd: { managerUid: 1000 } },
    definitionMutationCapability: definition,
    verdict: { kind: "owned", root: path.dirname(entrypoint), refreshDefinition: true },
  } as never);
}

describe.skipIf(process.platform === "win32")("npm destination on a release link", () => {
  it("switches and leaves the rebind to the restart when the service definition can be refreshed", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    const release = fixture.addRelease("r1", "2026.11.3");
    fixture.linkTo("r1");
    serviceStarting(path.join(release, "dist", "index.js"));

    const destination = await inspectNpmGlobalDestination(
      fixture.slot,
      createNpmTarget(fixture.globalRoot),
    );

    expect(destination).toMatchObject({
      kind: "owned",
      releaseBoundService: {
        releaseRoot: release,
        inPlace: false,
        installTarget: { packageRoot: fixture.slot },
      },
    });
    expect(fs.readlinkSync(fixture.slot)).toBe("../../releases/r1/lib/node_modules/openclaw");
  });

  it.each([
    ["the service definition is sealed", { kind: "sealed", reason: "inspection-failed" }, true],
    ["the update does not restart the Gateway", { kind: "writable" }, false],
  ] as const)(
    "updates the selected release in place with a warning when %s",
    async (_case, definition, restart) => {
      const fixture = createPackageReleasePrefixFixture(dir);
      const release = fixture.addRelease("r1", "2026.11.3");
      fixture.linkTo("r1");
      serviceStarting(path.join(release, "dist", "index.js"), definition);

      const destination = await inspectNpmGlobalDestination(
        fixture.slot,
        createNpmTarget(fixture.globalRoot),
        { restart },
      );

      expect(destination).toMatchObject({
        kind: "owned",
        releaseBoundService: {
          releaseRoot: release,
          inPlace: true,
          installTarget: { globalRoot: path.dirname(release), packageRoot: release },
        },
      });
      expect(destination.kind === "owned" && destination.releaseBoundService?.warning).toMatch(
        /inside the release.*gateway install --force/su,
      );
    },
  );

  it("admits a service that starts the package path", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    fixture.addRelease("r1", "2026.11.3");
    fixture.linkTo("r1");
    serviceStarting(path.join(fixture.slot, "openclaw.mjs"));

    const destination = await inspectNpmGlobalDestination(
      fixture.slot,
      createNpmTarget(fixture.globalRoot),
    );

    expect(destination.kind).toBe("owned");
  });
});
