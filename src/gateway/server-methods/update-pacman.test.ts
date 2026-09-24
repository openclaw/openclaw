import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import * as exec from "../../process/exec.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import {
  adoptUpdateCampaignMock,
  captureUpdateRunPayload,
  detectRespawnSupervisorMock,
  resolveStartupInstallStatusMock,
  resolveUpdateInstallSurfaceMock,
  scheduleGatewayRestartMock,
  startManagedServiceUpdateHandoffMock,
} from "./update.test-harness.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("returns pacman guidance without launching a managed updater or restarting", async () => {
  const root = dirs.make("pacman-rpc-");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw"}');
  resolveStartupInstallStatusMock.mockResolvedValue({
    root,
    status: { root, installKind: "package", packageManager: "npm" },
    installReceipt: null,
  });
  detectRespawnSupervisorMock.mockReturnValue("systemd");
  const access = fs.access.bind(fs);
  vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
    if (file !== "/usr/bin/pacman") {
      return access(file, mode);
    }
  });
  vi.spyOn(exec, "runCommandWithTimeout").mockResolvedValue({
    stdout: "openclaw\n",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  });
  await withMockedPlatform("linux", async () => {
    const response = await captureUpdateRunPayload();
    expect(response).toMatchObject({
      message: expect.stringContaining("sudo pacman -Syu"),
      result: { status: "skipped", reason: "unmanaged-package-install" },
      restart: null,
    });
    expect(getUpdateRun(response!.runId)).toMatchObject({
      status: "skipped",
      origin: { nextAction: expect.stringContaining("pacman") },
    });
  });
  expect(resolveUpdateInstallSurfaceMock).not.toHaveBeenCalled();
  expect(adoptUpdateCampaignMock).not.toHaveBeenCalled();
  expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
});
