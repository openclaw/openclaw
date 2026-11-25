import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createMacosAppInstallOwner } from "../../commands/test-runtime-config-helpers.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { expectNoCalls } from "../../test-utils/mock-call-assertions.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import {
  adoptUpdateCampaignMock,
  invokeUpdateRun,
  resolveUpdateInstallSurfaceMock,
  scheduleGatewayRestartMock,
  sentinelState,
  startManagedServiceUpdateHandoffMock,
} from "./update.test-harness.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function invokeInstalledUpdate(prepare: (root: string) => Promise<void>) {
  const packageRoot = await import("../../infra/openclaw-root.js");
  const ocmUpdate = await import("../../infra/ocm-update-client.js");
  const root = tempDirs.make("openclaw-host-owned-update-");
  vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(root);
  const resolveManager = vi.spyOn(ocmUpdate, "resolveOcmUpdateManager");
  const createRun = vi.spyOn(
    await import("../../infra/update-run-write.async.js"),
    "createUpdateRunAsync",
  );
  await prepare(root);
  const respond = vi.fn();
  await invokeUpdateRun({}, respond);
  expectNoUpdateEffects(resolveManager, createRun);
  return respond;
}

function expectNoUpdateEffects(...effects: MockInstance[]) {
  expectNoCalls(
    ...effects,
    adoptUpdateCampaignMock,
    startManagedServiceUpdateHandoffMock,
    scheduleGatewayRestartMock,
  );
  expect(sentinelState.capturedPayload).toBeUndefined();
}

it("refuses an app-owned Gateway update before delegation, history, or restart effects", async () => {
  const installOwner = createMacosAppInstallOwner();
  const respond = await invokeInstalledUpdate(async (root) => {
    await fs.writeFile(
      path.join(root, "openclaw-install-owner.json"),
      JSON.stringify(installOwner),
    );
  });
  expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
    code: "UNAVAILABLE",
    message: "Managed by OpenClaw.app. Update OpenClaw.app to update this Gateway.",
    details: { reason: "host-owned-install", installOwner },
    retryable: false,
  });
  expect(resolveUpdateInstallSurfaceMock).not.toHaveBeenCalled();
});

it("refuses immutable activation before manager delegation, history, campaign, or handoff", async () => {
  const immutableInstall = await import("../../infra/update-immutable-install.js");
  const respond = await invokeInstalledUpdate(async (root) => {
    vi.spyOn(immutableInstall, "inspectImmutableInstall").mockResolvedValue({
      root,
      currentPath: path.join(root, "releases", "a".repeat(40)),
      currentSha: "a".repeat(40),
    });
  });
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
});

it.each(["API", "WebUI"] as const)(
  "refuses an immutable surface discovered after %s admission without update side effects",
  async (transport) => {
    const immutableInstall = await import("../../infra/update-immutable-install.js");
    vi.spyOn(immutableInstall, "inspectImmutableInstall").mockResolvedValue(null);
    resolveUpdateInstallSurfaceMock.mockResolvedValue({
      kind: "immutable",
      mode: "unknown",
      root: "/opt/example",
      packageRoot: "/opt/example",
    });

    const inApp = transport === "WebUI";
    const sessionKey = "agent:main:webchat:immutable";
    if (inApp) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath: resolveDefaultSessionStorePath("main") },
        { sessionId: "immutable-refusal", updatedAt: 1, delivery: { kind: "internal" } },
      );
      const { extractDeliveryInfo } = await import("../../config/sessions/delivery-info.js");
      const sessions = await import("../../config/sessions.js");
      vi.mocked(sessions.extractDeliveryInfo).mockImplementationOnce(extractDeliveryInfo);
    }
    const respond = vi.fn();
    const broadcast = vi.fn();
    await invokeUpdateRun(
      inApp ? { sessionKey, requester: { channel: INTERNAL_MESSAGE_CHANNEL } } : {},
      respond,
      undefined,
      { broadcast },
      inApp
        ? {
            client: {
              connect: {
                client: {
                  id: GATEWAY_CLIENT_IDS.CONTROL_UI,
                  mode: GATEWAY_CLIENT_MODES.WEBCHAT,
                },
              },
            } as NonNullable<Parameters<typeof invokeUpdateRun>[4]>["client"],
          }
        : {},
    );

    const payload = respond.mock.calls.at(-1)?.[1];
    expect(payload).toMatchObject({
      ok: false,
      result: { status: "skipped", reason: "immutable-native-updater-required" },
      restart: null,
    });
    expect(payload.noticeInApp).toBe(inApp ? true : undefined);
    expect(getUpdateRun(payload.runId)).toMatchObject({
      status: "skipped",
      reason: "immutable-native-updater-required",
    });
    if (inApp) {
      expect(broadcast.mock.calls).toEqual([
        [
          "update.run.changed",
          expect.objectContaining({ runId: payload.runId, status: "running" }),
        ],
        [
          "update.run.changed",
          expect.objectContaining({ runId: payload.runId, status: "skipped" }),
        ],
      ]);
    } else {
      expect(broadcast).not.toHaveBeenCalled();
    }
    expectNoUpdateEffects();
  },
);
