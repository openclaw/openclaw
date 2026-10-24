import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveDevicePairing } from "../../../infra/device-pairing-approval.js";
import * as deviceTokens from "../../../infra/device-pairing-tokens.js";
import { getPairedDevice, requestDevicePairing } from "../../../infra/device-pairing.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as profileAuthority from "../../../state/user-channel-identity-operations.js";
import { linkEmail } from "../../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import * as expectedProfile from "../../expected-profile.js";
import { createDirectChatContext } from "../../server-chat.agent-events.test-helpers.js";
import { deviceHandlers } from "../../server-methods/devices.js";
import { createSecretsHandlers } from "../../server-methods/secrets.js";
import type { GatewayRequestOptions } from "../../server-methods/types.js";
import { disconnectStaleSharedGatewayAuthClients } from "../../server-shared-auth-generation.js";
import { holdGatewayPolicyResponse } from "../ws-policy-close.js";
import { createRequestGate } from "./authenticated-request-dispatch.fixtures.test-support.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
  dispatchProfile,
  requestFrame,
} from "./authenticated-request-dispatch.test-support.js";

const runtime = vi.hoisted(() => ({
  handler: vi.fn<(options: GatewayRequestOptions) => Promise<void>>(),
}));
vi.mock("./authenticated-request-dispatch.server-methods.runtime.js", () => ({
  handleGatewayRequest: runtime.handler,
}));

function createFixture() {
  const closed = createDeferredCore();
  const socketClose = vi.fn(() => closed.resolve());
  const client = createOperatorWsClient({ socket: { close: socketClose } });
  client.usesSharedGatewayAuth = true;
  const harness = createDispatchTestHarness();
  const dispatch = async (id: string, method = "secrets.reload", expectedProfileId?: string) =>
    await harness.dispatcher.dispatch(
      { ...requestFrame(id, method), ...(expectedProfileId ? { expectedProfileId } : {}) },
      client,
    );
  const invalidate = () =>
    disconnectStaleSharedGatewayAuthClients({ clients: [client], expectedGeneration: null });
  return { client, harness, dispatch, socketClose, closed, invalidate };
}

const profileBinding = (profile: { id: string; updatedAt: number }) =>
  dispatchProfile(profile.id, { updatedAt: profile.updatedAt });
const device = (id: string, publicKey: string) => ({
  id,
  publicKey,
  signature: "signature",
  signedAt: 1,
  nonce: "nonce",
});
const loadRouter = () =>
  vi.importActual<typeof import("../../server-methods.js")>("../../server-methods.js");

describe("policy writer response ownership", () => {
  beforeEach(() => {
    runtime.handler.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps a later revoke final across failed profile preparation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("credential-admin@example.test");
      const targetDeviceId = "another-device";
      const pairing = await requestDevicePairing({
        deviceId: targetDeviceId,
        publicKey: "another-device-public-key",
        role: "operator",
        scopes: ["operator.read"],
      });
      const approved = await approveDevicePairing(pairing.request.requestId, {
        callerScopes: ["operator.admin"],
      });
      expect(approved?.status).toBe("approved");
      const client = createOperatorWsClient({ socket: { close: vi.fn() } });
      client.authenticatedUserId = "credential-admin@example.test";
      client.authenticatedUserProfile = profileBinding(profile);
      client.connect.device = device("administrator-device", "administrator-public-key");
      client.isDeviceTokenAuth = true;
      const context = createDirectChatContext({
        getRuntimeConfig: () => ({}),
        logGateway: createSubsystemLogger("credential-order-test"),
        invalidateClientsForDevice: vi.fn(),
        disconnectClientsForDevice: vi.fn(),
      });
      const harness = createDispatchTestHarness({ buildRequestContext: () => context });
      const checkpoint = createDispatchTestHarness({ buildRequestContext: () => context });
      const { handleGatewayRequest } = await loadRouter();
      const credentialExecutions: Promise<void>[] = [];
      runtime.handler.mockImplementation(async (options) => {
        if (options.req.method === "test.credential-checkpoint") {
          // Starts are FIFO across dispatchers. Join earlier mutations that reached
          // the router, without waiting for the held connection's mutation barrier.
          await Promise.all(credentialExecutions);
          options.respond(true, {});
          return;
        }
        const execution = handleGatewayRequest({ ...options, extraHandlers: deviceHandlers });
        credentialExecutions.push(execution);
        await execution;
      });
      const preparation = createRequestGate();
      const prepareOriginal = profileAuthority.prepareUserProfileSelectionAuthority;
      vi.spyOn(profileAuthority, "prepareUserProfileSelectionAuthority").mockImplementationOnce(
        async (...args) => {
          await preparation.wait();
          return prepareOriginal(...args);
        },
      );
      const createBinding = expectedProfile.createExpectedProfileBinding;
      vi.spyOn(expectedProfile, "createExpectedProfileBinding")
        .mockImplementationOnce(createBinding)
        .mockRejectedValueOnce(new Error("middle profile preparation failed"));
      const dispatched: Promise<void>[] = [];
      const mutate = (id: string, method: string, expectedProfileId?: string) =>
        harness.dispatcher.dispatch(
          {
            ...requestFrame(id, method, { deviceId: targetDeviceId, role: "operator" }),
            ...(expectedProfileId ? { expectedProfileId } : {}),
          },
          client,
        );
      try {
        dispatched.push(mutate("rotate-before-revoke", "device.token.rotate", profile.id));
        await preparation.entered;
        await expect(
          mutate("failed-middle-rotation", "device.token.rotate", profile.id),
        ).rejects.toThrow("middle profile preparation failed");
        dispatched.push(mutate("final-revoke", "device.token.revoke"));
        await checkpoint.dispatcher.dispatch(
          requestFrame("checkpoint", "test.credential-checkpoint"),
          client,
        );
        preparation.release();
        await Promise.all(dispatched);
        expect(await harness.awaitResponseFrame("rotate-before-revoke")).toMatchObject({
          ok: true,
          payload: { tokenDelivery: "withheld-cross-device" },
        });
        expect(await harness.awaitResponseFrame("final-revoke")).toMatchObject({ ok: true });
        expect(client.invalidated).not.toBe(true);
        const stored = expectDefined(await getPairedDevice(targetDeviceId), "paired target");
        expect(stored.tokens?.operator?.revokedAtMs).toBeTypeOf("number");
      } finally {
        preparation.release();
        await Promise.allSettled(dispatched);
      }
    });
  });

  it.each(["success", "throw"] as const)(
    "redacts a held %s response after a real profile merge despite the policy-close exception",
    async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const source = ensureProfileForEmail("policy-source@example.test");
        const target = ensureProfileForEmail("policy-target@example.test");
        const fixture = createFixture();
        fixture.client.authenticatedUserProfile = profileBinding(source);
        const gate = createRequestGate();
        const receipt = { committed: true, accountData: "original-account-result" };
        const { handleGatewayRequest } = await loadRouter();
        runtime.handler.mockImplementation((options: GatewayRequestOptions) =>
          handleGatewayRequest({
            ...options,
            context: {
              ...options.context,
              getRuntimeConfig: () => ({}),
              logGateway: {
                ...createSubsystemLogger("gateway-test"),
                ...fixture.harness.logGateway,
              },
            },
            extraHandlers: {
              "config.patch": async ({ respond }) => {
                holdGatewayPolicyResponse(respond);
                await gate.wait();
                if (outcome === "throw") {
                  throw new Error("original-account-error");
                }
                respond(true, receipt, { code: "UNAVAILABLE", message: "original-account-error" });
              },
            },
          }),
        );
        const request = fixture.dispatch("bound-writer", "config.patch", source.id);
        await gate.during(request, () => {
          linkEmail("policy-source@example.test", target.id);
          // The accepted policy writer may bypass transport invalidation, never profile binding.
          fixture.invalidate();
        });
        expect(await fixture.harness.awaitResponseFrame("bound-writer")).toEqual({
          type: "res",
          id: "bound-writer",
          ok: false,
          payload: undefined,
          error: expect.objectContaining({
            details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "may_have_executed" },
          }),
        });
        expect(fixture.socketClose).toHaveBeenCalledOnce();
      });
    },
  );

  it.each([false, true])(
    "delivers a secrets activation result before closing (failed=%s)",
    async (failed) => {
      const fixture = createFixture();
      const gate = createRequestGate();
      const handlers = createSecretsHandlers({
        reloadSecrets: async () => {
          fixture.invalidate();
          await gate.wait();
          if (failed) {
            throw new Error("activation failed");
          }
          return { warningCount: 0 };
        },
        storeWriteService: {
          resolveUpdatedBy: () => "test",
          write: vi.fn(),
          reloadReference: async () => ({ reloaded: false }),
        },
        resolveSecrets: async () => ({ assignments: [], diagnostics: [], inactiveRefPaths: [] }),
      });
      runtime.handler.mockImplementation(async (options) => {
        await expectDefined(
          handlers[options.req.method],
          options.req.method,
        )({ ...options, params: {} });
      });
      const dispatch = fixture.dispatch("writer");
      await gate.during(dispatch, async () => {
        expect(fixture.client.invalidated).toBe(true);
        expect(fixture.socketClose).not.toHaveBeenCalled();
        await fixture.dispatch("revoked", "health");
        expect(runtime.handler).toHaveBeenCalledOnce();
        expect(fixture.harness.send).not.toHaveBeenCalled();
        gate.release();
        expect(await fixture.harness.awaitResponseFrame("writer")).toMatchObject({
          ok: !failed,
          ...(failed ? { error: { message: "secrets.reload failed" } } : {}),
        });
        await fixture.closed.promise;
        expect(fixture.socketClose).toHaveBeenCalledExactlyOnceWith(4001, "gateway auth changed");
        expect(fixture.harness.send).toHaveBeenCalledBefore(fixture.socketClose);
      });
    },
  );

  it("keeps only accepted config.patch results, then closes after the last result", async () => {
    const fixture = createFixture();
    const writers = ["first", "second"].map((id) => Object.assign(createRequestGate(), { id }));
    const read = createRequestGate();
    runtime.handler.mockImplementation(async ({ req, respond }) => {
      const writer = writers.find(({ id }) => id === req.id);
      if (writer) {
        holdGatewayPolicyResponse(respond);
        await writer.wait();
        respond(true, { committed: req.id });
      } else {
        await read.wait();
        respond(true, { private: "old-authority-read" });
      }
    });
    const dispatches = [fixture.dispatch("read", "health")];
    try {
      await read.entered;
      for (const writer of writers) {
        dispatches.push(fixture.dispatch(writer.id, "config.patch"));
        await writer.entered;
      }
      fixture.invalidate();
      read.release();
      await dispatches[0];
      expect(fixture.harness.send).not.toHaveBeenCalled();
      for (const [index, writer] of writers.entries()) {
        expect(fixture.socketClose).not.toHaveBeenCalled();
        writer.release();
        expect(await fixture.harness.awaitResponseFrame(writer.id)).toMatchObject({ ok: true });
        expect(fixture.harness.send).toHaveBeenCalledTimes(index + 1);
      }
      await fixture.closed.promise;
      expect(fixture.socketClose).toHaveBeenCalledOnce();
    } finally {
      read.release();
      for (const writer of writers) {
        writer.release();
      }
      await Promise.all(dispatches);
    }
  });

  it("does not reserve a replacement bearer before the token mutation finishes", async () => {
    const fixture = createFixture();
    fixture.client.isDeviceTokenAuth = true;
    fixture.client.usesSharedGatewayAuth = false;
    fixture.client.connect.device = device("self", "public");
    const gate = createRequestGate();
    const closed = createDeferredCore();
    const invalidateClientsForDevice = vi.fn();
    const disconnectClientsForDevice = vi.fn();
    fixture.harness.close.mockImplementation(() => closed.resolve());
    vi.spyOn(deviceTokens, "rotateDeviceToken").mockImplementationOnce(async () => {
      await gate.wait();
      return {
        ok: true,
        entry: {
          token: "synthetic-replacement",
          role: "operator",
          scopes: ["operator.pairing"],
          createdAtMs: 1,
        },
      };
    });
    runtime.handler.mockImplementation(async (options) => {
      await expectDefined(
        deviceHandlers[options.req.method],
        options.req.method,
      )({
        ...options,
        params: { deviceId: "self", role: "operator" },
        context: {
          ...options.context,
          logGateway: { ...createSubsystemLogger("gateway-test"), ...fixture.harness.logGateway },
          invalidateClientsForDevice,
          disconnectClientsForDevice,
        },
      });
    });
    const dispatch = fixture.dispatch("writer", "device.token.rotate");
    await gate.during(dispatch, async () => {
      // Invalidation is the authority fence; defer transport close so the test
      // detects an illicit held response even when the socket could still send.
      fixture.client.invalidated = true;
      fixture.client.invalidatedReason = "device-token-revoked";
      gate.release();
      await Promise.race([closed.promise, fixture.harness.awaitResponseFrame("writer")]);
      expect(fixture.harness.send.mock.calls.length).toBe(0);
      expect(fixture.harness.close).toHaveBeenCalledWith(
        4001,
        "client invalidated: device-token-revoked",
      );
      expect(invalidateClientsForDevice).toHaveBeenCalledWith("self", {
        role: "operator",
        reason: "device-token-rotated",
      });
      expect(disconnectClientsForDevice).toHaveBeenCalledWith("self", { role: "operator" });
    });
  });

  it("releases a revoked writer when its handler returns without responding", async () => {
    const fixture = createFixture();
    runtime.handler.mockImplementation(async ({ respond }) => {
      holdGatewayPolicyResponse(respond);
      fixture.invalidate();
    });
    await fixture.dispatch("writer", "config.apply");
    await fixture.closed.promise;
    expect(fixture.socketClose).toHaveBeenCalledOnce();
    expect(fixture.harness.send).not.toHaveBeenCalled();
  });
});
