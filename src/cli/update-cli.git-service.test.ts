import { expect, it, vi } from "vitest";
import { getMockCallOutput } from "./test-runtime-capture.js";
import * as checks from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as cli from "./update-cli-modules.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

const f = createUpdateCliFixture();

const gatewayArgs = (entry: string) => ["node", entry, "gateway", "run"];

it("disarms legacy updater jobs before stopping the gateway without polluting JSON stdout", async () => {
  const tempDir = f.tempDirs.make("openclaw-update-json-stop-service-");
  const { nodeModules, entryPath } = await f.setupInstalledPackageRoot(tempDir);
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  f.mockRunningManagedGateway(gatewayArgs(entryPath));
  mocks.serviceStop.mockImplementationOnce(async (params: { stdout?: NodeJS.WritableStream }) => {
    params.stdout?.write("Stopped systemd service: openclaw-gateway.service\n");
  });
  mocks.launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob.mockResolvedValue(true);
  f.mockFileBackedPathExists();
  f.mockNpmGlobalRoot(nodeModules);

  await cli.updateCommand({ yes: true, json: true });
  const writes = getMockCallOutput(stdoutWrite);

  expect(writes).not.toContain("Stopped systemd service");
  expect(mocks.serviceStop).toHaveBeenCalled();
  const cleanupOrder =
    mocks.launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob.mock
      .invocationCallOrder[0];
  const serviceStopOrder = mocks.serviceStop.mock.invocationCallOrder[0];
  expect(checks.requireValue(cleanupOrder, "launchd updater cleanup order")).toBeLessThan(
    checks.requireValue(serviceStopOrder, "service stop order"),
  );
});
