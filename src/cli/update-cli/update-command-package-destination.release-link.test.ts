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

/** The managed service as the service manager reports it; only its start command matters here. */
function serviceStarting(entrypoint: string) {
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(entrypoint, "", { flag: "a" });
  vi.spyOn(servicePlan, "isGatewayServiceManagementAllowedForUpdate").mockReturnValue(true);
  vi.spyOn(servicePlan, "readManagedGatewayServiceForUpdate").mockResolvedValue({
    command: { programArguments: ["/usr/bin/node", entrypoint, "gateway", "--port", "18789"] },
  } as never);
}

describe.skipIf(process.platform === "win32")("npm destination on a release link", () => {
  it("replaces the release in place when the service starts it by its real path", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    const release = fixture.addRelease("r1", "2026.11.3");
    fixture.linkTo("r1");
    serviceStarting(path.join(release, "dist", "index.js"));

    const destination = await inspectNpmGlobalDestination(
      fixture.slot,
      createNpmTarget(fixture.globalRoot),
    );

    // The update targets the release itself, so the service starts the new version.
    expect(destination).toMatchObject({
      kind: "owned",
      releaseBoundService: {
        releaseRoot: release,
        installTarget: { globalRoot: path.dirname(release), packageRoot: release },
      },
    });
    expect(destination.kind === "owned" && destination.releaseBoundService?.warning).toMatch(
      /in place.*gateway install --force/su,
    );
    expect(fs.readlinkSync(fixture.slot)).toBe("../../releases/r1/lib/node_modules/openclaw");
  });

  it("admits a service that starts the package path", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    fixture.addRelease("r1", "2026.11.3");
    fixture.linkTo("r1");
    serviceStarting(path.join(fixture.slot, "openclaw.mjs"));

    const destination = await inspectNpmGlobalDestination(
      fixture.slot,
      createNpmTarget(fixture.globalRoot),
    );

    expect(destination).toEqual({ kind: "owned" });
  });
});
