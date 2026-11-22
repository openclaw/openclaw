import { describe, expect, it, vi } from "vitest";
import * as proof from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as modules from "./update-cli-modules.test-support.js";
import { writeOpenClawPackageFixture } from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const setup = createUpdateCliFixture();
  const { updateCommand } = modules;

  it.each([
    { scenario: "different Node", command: "gateway", selected: true },
    { scenario: "non-Gateway command", command: "agent", selected: false },
  ])(
    "plans service Node selection independently of database admission ($scenario)",
    async ({ command, selected }) => {
      const root = setup.createCaseDir("openclaw-same-root");
      const entrypoint = await writeOpenClawPackageFixture(root, "2026.5.18");
      const serviceNode = "/opt/other-node/bin/node";
      setup.mockPackageInstallStatus(root);
      setup.primeServiceCommand([serviceNode, "--import", "tsx", entrypoint, command]);

      await updateCommand({ dryRun: true });
      if (command !== "gateway") {
        expect(proof.getLogOutput()).toContain("Stop the Gateway through its owner");
      }

      expect(mocks.serviceReadCommand).toHaveBeenCalledTimes(2);
      const logs = proof.getLogOutput();
      expect(logs).not.toContain("Targeting managed gateway service package root");
      if (selected) {
        expect(logs).toContain("differs from the managed gateway service runtime");
        expect(logs).toContain(serviceNode);
        expect(logs).toContain(
          "Using the managed service runtime for this update so the gateway can start after the upgrade",
        );
      } else {
        expect(logs).not.toContain("differs from the managed gateway service runtime");
        expect(logs).not.toContain(serviceNode);
      }
    },
  );
});
