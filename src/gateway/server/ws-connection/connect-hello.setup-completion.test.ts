import { afterEach, aroundEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  issueDeviceBootstrapToken,
  issueDevicePairSetupBootstrapToken,
  readDevicePairSetupCompletion as readCompletion,
  verifyDeviceBootstrapToken,
} from "../../../infra/device-bootstrap.js";
import { persistDevicePairingStoreState } from "../../../infra/device-pairing-store.js";
import { getPairedDevice } from "../../../infra/device-pairing.js";
import type { PairedDevice } from "../../../infra/device-pairing.types.js";
import { PAIRING_SETUP_BOOTSTRAP_PROFILE as bootstrapProfile } from "../../../shared/device-bootstrap-profile.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createPresencePublisher } from "../presence-events.js";

// mock-isolation: Hello completion uses a fixed health snapshot without starting health refreshes.
vi.mock("../health-state.js", () => ({
  buildGatewaySnapshot: vi.fn(() => ({
    presence: [],
    health: {},
    stateVersion: { presence: 1, health: 1 },
  })),
  getHealthCache: vi.fn(() => null),
  getHealthVersion: vi.fn(() => 1),
}));

vi.mock("../../../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/user-profile-list.js")>()),
  hasMultipleResidentSessionSharingIdentities: vi.fn(() => false),
}));

vi.mock("../../control-ui-plugin-tabs.js", () => ({
  listControlUiLinkReaders: vi.fn(() => []),
  listControlUiPluginTabs: vi.fn(() => []),
  listControlUiPluginWidgetKinds: vi.fn(() => []),
}));

// mock-isolation: Synthetic bootstrap attempts must not write to the security event journal.
vi.mock("./connect-auth-security.js", () => ({ emitGatewayAuthSecurityEvent: vi.fn() }));

import { sendGatewayHello } from "./connect-hello.js";

function persistPaired(paired: PairedDevice) {
  persistDevicePairingStoreState(
    { pendingById: {}, pairedByDeviceId: { [paired.deviceId]: paired } },
    undefined,
    "paired",
  );
}

function createPaired(name: string, overrides: Partial<PairedDevice> = {}): PairedDevice {
  const paired = {
    deviceId: `device-${name}`,
    publicKey: `public-key-${name}`,
    createdAtMs: 1,
    approvedAtMs: 2,
    ...overrides,
  };
  persistPaired(paired);
  return paired;
}

async function verifyBootstrap(paired: PairedDevice, token: string) {
  const params = {
    token,
    deviceId: paired.deviceId,
    publicKey: paired.publicKey,
    role: "operator" as const,
    scopes: bootstrapProfile.scopes,
  };
  await expect(verifyDeviceBootstrapToken(params)).resolves.toEqual({ ok: true });
  return params;
}

async function createSetup(name: string, overrides: Partial<PairedDevice> = {}) {
  const paired = createPaired(name, overrides);
  const issued = await issueDevicePairSetupBootstrapToken({ profile: bootstrapProfile });
  const verifyParams = await verifyBootstrap(paired, issued.token);
  return { paired, issued, verifyParams, state: createBootstrapState(paired, issued.token) };
}

function createBootstrapState(paired: PairedDevice, bootstrapTokenCandidate: string) {
  return {
    resolvedAuth: { mode: "none" },
    role: "operator",
    scopes: bootstrapProfile.scopes,
    device: { id: paired.deviceId },
    devicePublicKey: paired.publicKey,
    hasTokenAuth: false,
    hasPasswordAuth: false,
    bootstrapTokenCandidate,
    authResult: { ok: true, method: "bootstrap-token" },
    authMethod: "bootstrap-token",
    issuedBootstrapProfile: bootstrapProfile,
    handoffBootstrapProfile: bootstrapProfile,
    deviceToken: null,
    bootstrapDeviceTokens: [],
  };
}

function createFailedHelloContext(
  sendFrame: () => Promise<void> = rejectHello,
  broadcast = vi.fn(),
) {
  return {
    handler: {
      getClient: () => null,
      connId: "conn-setup",
      gatewayMethods: [],
      events: [],
      buildRequestContext: () => ({ broadcast, publishPresence: vi.fn() }),
      refreshHealthSnapshot: vi.fn(async () => ({})),
      close: vi.fn(),
      advanceHandshakePhase: vi.fn(),
      setCloseCause: vi.fn(),
      logGateway: { warn: vi.fn() },
      logHealth: { error: vi.fn() },
    },
    frame: { id: "hello-setup" },
    connectParams: {
      client: { id: "openclaw-ios", version: "dev", platform: "test", mode: "backend" },
      role: "operator",
      scopes: bootstrapProfile.scopes,
    },
    configSnapshot: {},
    sendHandshakeErrorResponse: vi.fn(),
    sendFrame: vi.fn(sendFrame),
    onHelloDelivered: vi.fn(),
    pendingNodePairingCleanup: {},
    releasePendingNodePairingCleanup: vi.fn(async () => undefined),
  };
}

async function rejectHello() {
  throw new Error("socket closed");
}

afterEach(() => vi.clearAllMocks());

aroundEach((runTest) =>
  withOpenClawTestState({ label: "ws-setup-completion", layout: "state-only" }, runTest),
);

it.each([false, true])(
  "confirms setup status before queued presence delivery (failure=%s)",
  async (presenceFails) => {
    const { paired, issued, state } = await createSetup("setup-order", {
      displayName: "Test phone",
    });

    const handoffStarted = createDeferred();
    const releaseHandoff = createDeferred();
    const releaseMetadata = createDeferred();
    let metadataTail: Promise<void> | undefined;
    const onHelloDelivered = vi.fn();
    const broadcast = vi.fn((event: string) => {
      if (presenceFails && event === "presence") {
        throw new Error("test presence publication failure");
      }
    });
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const presence = createPresencePublisher({
      scheduler,
      broadcast,
      incrementPresenceVersion: () => 2,
      getHealthVersion: () => 1,
      prepare: () => undefined,
    });
    onTestFinished(async () => {
      presence.stop();
      await scheduler.stop();
    });
    const base = createFailedHelloContext(async () => {
      handoffStarted.resolve();
      await releaseHandoff.promise;
    }, broadcast);
    const context = {
      ...base,
      handler: {
        ...base.handler,
        getClient: () => ({ presenceKey: "conn-setup-order", socket: { readyState: 1 } }),
        isClosed: () => false,
        buildRequestContext: () => ({ broadcast, publishPresence: presence.publish }),
      },
      onHelloDelivered,
      pendingDeviceMetadata: {
        deviceId: paired.deviceId,
        identity: paired,
        patch: { displayName: "After hello" },
      },
      runDetachedConnectWork: vi.fn((run: () => Promise<void>) => {
        metadataTail = releaseMetadata.promise.then(run);
      }),
    };

    const hello = sendGatewayHello(context as never, state as never, {});
    await handoffStarted.promise;
    const completionAtHandoff = await readCompletion({ setupId: issued.setupId });
    releaseHandoff.resolve();
    try {
      await hello;
      expect(context.runDetachedConnectWork).toHaveBeenCalledOnce();
      expect((await getPairedDevice(paired.deviceId))?.displayName).toBe(paired.displayName);
    } finally {
      releaseMetadata.resolve();
      await metadataTail;
    }
    expect((await getPairedDevice(paired.deviceId))?.displayName).toBe("After hello");
    expect(broadcast.mock.calls.some(([event]) => event === "presence")).toBe(false);
    await clock.advanceBy(200);
    const completionAfterHandoff = await readCompletion({ setupId: issued.setupId });

    expect(completionAtHandoff).toMatchObject({
      setupId: issued.setupId,
      deviceId: paired.deviceId,
      deviceName: paired.displayName,
      access: "limited",
      deliveryState: "uncertain",
    });
    expect(completionAfterHandoff).toMatchObject({ deliveryState: "confirmed" });
    expect(onHelloDelivered).toHaveBeenCalledOnce();
    expect(onHelloDelivered.mock.invocationCallOrder[0]).toBeLessThan(
      broadcast.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(broadcast).toHaveBeenCalledWith(
      "device.pair.setup.completed",
      expect.objectContaining({ setupId: issued.setupId }),
      { dropIfSlow: true },
    );
    const publications = broadcast.mock.calls.map(([event]) => event);
    expect(publications.indexOf("device.pair.setup.completed")).toBeLessThan(
      publications.indexOf("presence"),
    );
  },
);

it("keeps correlated setup completion uncertain when hello delivery fails", async () => {
  const { paired, issued, verifyParams, state } = await createSetup("setup-send-failure", {
    displayName: "Test phone",
  });

  const broadcast = vi.fn();
  const context = createFailedHelloContext(rejectHello, broadcast);
  const { onHelloDelivered } = context;
  const { close } = context.handler;

  await sendGatewayHello(context as never, state as never, {});

  expect(close).toHaveBeenCalled();
  expect(onHelloDelivered).not.toHaveBeenCalled();
  expect(broadcast).toHaveBeenCalledWith(
    "device.pair.setup.deliveryUncertain",
    expect.objectContaining({ setupId: issued.setupId, deviceId: paired.deviceId }),
    { dropIfSlow: true },
  );
  expect(broadcast.mock.calls.some(([event]) => event === "device.pair.setup.completed")).toBe(
    false,
  );
  await expect(readCompletion({ setupId: issued.setupId })).resolves.toMatchObject({
    setupId: issued.setupId,
    deviceId: paired.deviceId,
    deliveryState: "uncertain",
  });
  await expect(verifyDeviceBootstrapToken(verifyParams)).resolves.toEqual({
    ok: false,
    reason: "bootstrap_token_invalid",
  });
});

it("does not consume a setup bearer after the paired public key is replaced", async () => {
  const { paired, issued, verifyParams, state } = await createSetup("setup-replaced", {
    publicKey: "public-key-original",
  });
  persistPaired({ ...paired, publicKey: "public-key-replacement" });
  const context = createFailedHelloContext(async () => undefined);
  const { close } = context.handler;

  await sendGatewayHello(context as never, state as never, {});

  expect(close).toHaveBeenCalled();
  expect(context.sendFrame).not.toHaveBeenCalled();
  await expect(readCompletion({ setupId: issued.setupId })).resolves.toBeNull();
  await expect(verifyDeviceBootstrapToken(verifyParams)).resolves.toEqual({ ok: true });
});

it.each(["preparation", "transport"] as const)(
  "restores an uncorrelated bootstrap token when hello %s fails",
  async (failure) => {
    const paired = createPaired("generic-send-failure");
    const issued = await issueDeviceBootstrapToken({ profile: bootstrapProfile });
    const verifyParams = await verifyBootstrap(paired, issued.token);

    const context = createFailedHelloContext();
    const { close } = context.handler;
    const state = createBootstrapState(paired, issued.token);

    if (failure === "preparation") {
      const identity = await import("../../control-ui-identity.js");
      const preparationFailure = vi
        .spyOn(identity, "resolveControlUiIdentity")
        .mockImplementationOnce(() => {
          throw new Error("synthetic identity preparation failure");
        });
      try {
        await expect(sendGatewayHello(context as never, state as never, {})).rejects.toThrow(
          "synthetic identity preparation failure",
        );
        expect(close).not.toHaveBeenCalled();
        expect(context.sendFrame).not.toHaveBeenCalled();
      } finally {
        preparationFailure.mockRestore();
      }
    } else {
      await sendGatewayHello(context as never, state as never, {});
      expect(close).toHaveBeenCalledWith(1011, "gateway hello delivery failed");
    }
    await expect(verifyDeviceBootstrapToken(verifyParams)).resolves.toEqual({ ok: true });
  },
);
