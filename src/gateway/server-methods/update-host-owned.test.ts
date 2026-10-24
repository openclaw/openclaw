import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
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

async function installRoot() {
  const packageRoot = await import("../../infra/openclaw-root.js");
  const ocmUpdate = await import("../../infra/ocm-update-client.js");
  const root = tempDirs.make("openclaw-host-owned-update-");
  vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(root);
  return {
    root,
    resolveManager: vi.spyOn(ocmUpdate, "resolveOcmUpdateManager"),
    createRun: vi.spyOn(
      await import("../../infra/update-run-write.async.js"),
      "createUpdateRunAsync",
    ),
  };
}

function expectNoUpdateEffects(...effects: MockInstance[]) {
  for (const effect of [
    ...effects,
    adoptUpdateCampaignMock,
    startManagedServiceUpdateHandoffMock,
    scheduleGatewayRestartMock,
  ]) {
    expect(effect).not.toHaveBeenCalled();
  }
  expect(sentinelState.capturedPayload).toBeUndefined();
}

it("refuses an app-owned Gateway update before delegation, history, or restart effects", async () => {
  const { root, resolveManager, createRun } = await installRoot();
  const installOwner = {
    schemaVersion: 1,
    owner: "macos-app",
    displayName: "OpenClaw.app",
    updateHint: "Update OpenClaw.app to update this Gateway.",
  };
  await fs.writeFile(path.join(root, "openclaw-install-owner.json"), JSON.stringify(installOwner));
  const respond = vi.fn();

  await invokeUpdateRun({}, respond);

  expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
    code: "UNAVAILABLE",
    message: "Managed by OpenClaw.app. Update OpenClaw.app to update this Gateway.",
    details: { reason: "host-owned-install", installOwner },
    retryable: false,
  });
  expectNoUpdateEffects(resolveManager, createRun, resolveUpdateInstallSurfaceMock);
});

it("refuses immutable activation before manager delegation, history, campaign, or handoff", async () => {
  const immutableInstall = await import("../../infra/update-immutable-install.js");
  const { root, resolveManager, createRun } = await installRoot();
  vi.spyOn(immutableInstall, "inspectImmutableInstall").mockResolvedValue({
    root,
    currentPath: path.join(root, "releases", "a".repeat(40)),
    currentSha: "a".repeat(40),
  });
  const respond = vi.fn();

  await invokeUpdateRun({}, respond);

  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: "UNAVAILABLE",
      details: { reason: "immutable-native-updater-required" },
      message: expect.stringContaining(
        "root installation owner outside the Gateway service cgroup",
      ),
    }),
  );
  expectNoUpdateEffects(resolveManager, createRun);
});

it("refuses an immutable surface discovered after initial admission before campaign adoption", async () => {
  const immutableInstall = await import("../../infra/update-immutable-install.js");
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
    result: { status: "skipped", reason: "immutable-native-updater-required" },
    restart: null,
  });
  expectNoUpdateEffects();
});
