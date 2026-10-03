import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as ocmUpdate from "../../infra/ocm-update-client.js";
import * as packageRoot from "../../infra/openclaw-root.js";
import * as immutableInstall from "../../infra/update-immutable-install.js";
import * as updateLedger from "../../infra/update-run-ledger.js";
import {
  adoptUpdateCampaignMock,
  invokeUpdateRun,
  captureUpdateRunPayload,
  resolveUpdateInstallSurfaceMock,
  scheduleGatewayRestartMock,
  sentinelState,
  startManagedServiceUpdateHandoffMock,
} from "./update.test-harness.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("refuses an app-owned Gateway update before delegation, history, or restart effects", async () => {
  const root = tempDirs.make("openclaw-app-update-");
  const installOwner = {
    schemaVersion: 1,
    owner: "macos-app",
    displayName: "OpenClaw.app",
    updateHint: "Update OpenClaw.app to update this Gateway.",
  };
  await fs.writeFile(path.join(root, "openclaw-install-owner.json"), JSON.stringify(installOwner));
  vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(root);
  const resolveManager = vi.spyOn(ocmUpdate, "resolveOcmUpdateManager");
  const createRun = vi.spyOn(updateLedger, "createUpdateRun");
  const respond = vi.fn();

  await invokeUpdateRun({}, respond);

  expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
    code: "UNAVAILABLE",
    message: "Managed by OpenClaw.app. Update OpenClaw.app to update this Gateway.",
    details: { reason: "host-owned-install", installOwner },
    retryable: false,
  });
  expect(resolveManager).not.toHaveBeenCalled();
  expect(createRun).not.toHaveBeenCalled();
  expect(resolveUpdateInstallSurfaceMock).not.toHaveBeenCalled();
  expect(adoptUpdateCampaignMock).not.toHaveBeenCalled();
  expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
  expect(sentinelState.capturedPayload).toBeUndefined();
});

it("refuses immutable activation before manager delegation, history, campaign, or handoff", async () => {
  const root = tempDirs.make("openclaw-immutable-update-rpc-");
  vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(root);
  vi.spyOn(immutableInstall, "inspectImmutableInstall").mockResolvedValue({
    root,
    currentPath: path.join(root, "releases", "a".repeat(40)),
    currentSha: "a".repeat(40),
  });
  const resolveManager = vi.spyOn(ocmUpdate, "resolveOcmUpdateManager");
  const createRun = vi.spyOn(updateLedger, "createUpdateRun");
  const respond = vi.fn();

  await invokeUpdateRun({}, respond);

  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: "UNAVAILABLE",
      details: { reason: "immutable-activation-unavailable" },
      message: expect.stringContaining("prepare a sealed generation"),
    }),
  );
  expect(resolveManager).not.toHaveBeenCalled();
  expect(createRun).not.toHaveBeenCalled();
  expect(adoptUpdateCampaignMock).not.toHaveBeenCalled();
  expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
  expect(sentinelState.capturedPayload).toBeUndefined();
});

it("refuses an immutable surface discovered after initial admission before campaign adoption", async () => {
  vi.spyOn(immutableInstall, "inspectImmutableInstall").mockResolvedValue(null);
  resolveUpdateInstallSurfaceMock.mockResolvedValue({
    kind: "immutable",
    mode: "unknown",
    root: "/opt/example",
    packageRoot: "/opt/example",
  });

  const payload = await captureUpdateRunPayload();

  expect(payload).toMatchObject({
    ok: false,
    result: { status: "skipped", reason: "immutable-activation-unavailable" },
    restart: null,
  });
  expect(adoptUpdateCampaignMock).not.toHaveBeenCalled();
  expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
  expect(sentinelState.capturedPayload).toBeUndefined();
});
