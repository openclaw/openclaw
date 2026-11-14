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
  vi.spyOn(servicePlan, "isGatewayServiceManagementAllowedForUpdate").mockReturnValue(true);
  vi.spyOn(servicePlan, "readManagedGatewayServiceForUpdate").mockResolvedValue({
    command: { programArguments: [process.execPath, entrypoint, "gateway", "--port", "18789"] },
  } as never);
}

describe.skipIf(process.platform === "win32")("npm destination on a release link", () => {
  it("refuses before any change when the service starts the release by its real path", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    const release = fixture.addRelease("r1", "2026.11.3");
    fixture.linkTo("r1");
    serviceStarting(path.join(release, "openclaw.mjs"));

    const destination = await inspectNpmGlobalDestination(
      fixture.slot,
      createNpmTarget(fixture.globalRoot),
    );

    expect(destination.kind).toBe("foreign");
    expect("message" in destination && destination.message).toMatch(
      /gateway install --force.*package path/su,
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

    expect(destination.kind).toBe("owned");
  });
});
