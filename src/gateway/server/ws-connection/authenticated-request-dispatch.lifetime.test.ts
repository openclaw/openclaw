import { EventEmitter } from "node:events";
import "../../../test-utils/prepare-compiled-subprocesses.js";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../../../config/paths.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { GatewayRequestOptions } from "../../server-methods/types.js";
import { createRequestGate } from "./authenticated-request-dispatch.fixtures.test-support.js";

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.doUnmock("./authenticated-request-dispatch.server-methods.runtime.js");
  vi.doUnmock("./request-start.js");
  vi.doUnmock("../../session-sharing.js");
  vi.doUnmock("../../session-sharing-authorization-async.js");
  vi.doUnmock("../../session-sharing-target-input.js");
  vi.doUnmock("../../server-methods/gateway-personal-caller.js");
  vi.resetModules();
});

function mockDispatchStage(
  stage: string,
  hold: () => Promise<void>,
  handler: (options: GatewayRequestOptions) => Promise<void>,
) {
  // mock-isolation: Hold dispatch entry so the test can revoke authority before the handler runs.
  vi.doMock("./authenticated-request-dispatch.server-methods.runtime.js", async () => {
    if (stage === "lazy import") {
      await hold();
    }
    const { handleGatewayRequest } =
      stage === "profile authorization"
        ? await vi.importActual<typeof import("../../server-methods.js")>("../../server-methods.js")
        : { handleGatewayRequest: handler };
    return { handleGatewayRequest };
  });
  if (stage === "start scheduler") {
    vi.doMock("./request-start.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./request-start.js")>()),
      scheduleGatewayRequestStart: hold,
    }));
  }
}

describe("authenticated request completion", { concurrent: false }, () => {
  it("holds reconnect capacity through handler settlement (throw)", async () => {
    const held = createDeferredCore();
    const full = createDeferredCore();
    const starts: string[] = [];
    // mock-isolation: Control handler settlement to measure reconnect capacity ownership.
    vi.doMock("./authenticated-request-dispatch.server-methods.runtime.js", () => ({
      handleGatewayRequest: async ({ req, respond }: GatewayRequestOptions) => {
        starts.push(req.id);
        respond(true);
        if (starts.length === 4) {
          void nextTurn().then(full.resolve);
        }
        await held.promise;
        throw new Error("synthetic preparation failure");
      },
    }));
    const { createDispatchTestHarness, createOperatorWsClient, requestFrame } =
      await import("./authenticated-request-dispatch.test-support.js");
    const harness = createDispatchTestHarness();
    const client = createOperatorWsClient();
    const calls = Array.from({ length: 8 }, (_, index) =>
      harness.dispatcher.dispatch(requestFrame(String(index), "sessions.subscribe"), client),
    );
    try {
      await full.promise;
      expect(starts).toEqual(["0", "1", "2", "3"]);
    } finally {
      held.resolve();
      await Promise.all(calls);
    }
    expect(starts).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
  });

  it.for(["lazy import", "start scheduler"] as const)(
    "rejects access revoked during %s before entering the handler",
    async (stage, { signal }) => {
      const gate = createRequestGate(signal);
      const grant = new AbortController();
      const handleGatewayRequest = vi.fn(async () => {});
      mockDispatchStage(stage, gate.wait, handleGatewayRequest);
      const { createDispatchTestHarness, createOperatorWsClient, requestFrame } =
        await import("./authenticated-request-dispatch.test-support.js");
      const harness = createDispatchTestHarness();
      const client = createOperatorWsClient({ socket: new EventEmitter() });
      client.internal = {
        operatorAccessAuthority: {
          signal: grant.signal,
          assertCurrent: () => grant.signal.throwIfAborted(),
        },
      };
      const dispatch = harness.dispatcher.dispatch(
        requestFrame("revoked", "test.lifetime"),
        client,
      );
      await gate.during(dispatch, () => {
        grant.abort(new Error("Access ended"));
      });
      expect(handleGatewayRequest).not.toHaveBeenCalled();
      expect([...harness.clients.authorityClients]).toEqual([]);
    },
  );

  it.for([
    "lazy import",
    "start scheduler",
    "profile authorization",
    "handler after response",
  ] as const)(
    "joins %s before its caller can restore state selection",
    async (stage, { signal }) => {
      const gate = createRequestGate(signal);
      const finished = createDeferredCore();
      const initialRoot = path.join(os.tmpdir(), "dispatch-lifetime", "fixture");
      const restoredRoot = path.join(os.tmpdir(), "dispatch-lifetime", "restored");
      // Exercise late path selection without opening a store or changing process selectors.
      const selection = { OPENCLAW_STATE_DIR: initialRoot };
      let selectedRoot: string | undefined;
      let dispatched = false;
      const handleGatewayRequest = async (options: GatewayRequestOptions) => {
        try {
          options.respond(true, { accepted: true });
          if (stage === "handler after response") {
            await gate.wait();
          }
          selectedRoot = resolveStateDir(selection);
        } finally {
          finished.resolve();
        }
      };
      mockDispatchStage(stage, gate.wait, handleGatewayRequest);
      if (stage === "profile authorization") {
        // This admin auxiliary request has no session target or personal-caller policy.
        // Keep the real router/profile fence without loading those unrelated runtimes.
        vi.doMock("../../session-sharing.js", async () => {
          const { SessionMutationAuthorizationChangedError } =
            await import("../../session-mutation-authorization-error.js");
          return {
            SessionMutationAuthorizationChangedError,
            resolveSessionMutationAuthorization: () => ({ error: null }),
          };
        });
        // mock-isolation: This admin auxiliary request has no session target or sharing storage.
        vi.doMock("../../session-sharing-authorization-async.js", () => ({
          resolveSessionMutationAuthorizationAsync: async () => ({ error: null }),
        }));
        vi.doMock("../../session-sharing-target-input.js", () => ({
          resolveDirectIncognitoTargets: () => [],
          resolveDirectSessionTargets: () => [],
        }));
        vi.doMock("../../server-methods/gateway-personal-caller.js", () => ({
          isSyntheticGatewayCaller: () => false,
        }));
      }
      const { createDispatchTestHarness, createOperatorWsClient, dispatchProfile, requestFrame } =
        await import("./authenticated-request-dispatch.test-support.js");
      const harness = createDispatchTestHarness({
        extraHandlers: { "test.lifetime": handleGatewayRequest },
        buildRequestContext: () => ({ getRuntimeConfig: () => ({}) }),
      });
      const client = createOperatorWsClient({ socket: new EventEmitter() });
      if (stage === "profile authorization") {
        client.authenticatedGitHubIdentitySync = async () => {
          await gate.wait();
          client.authenticatedUserProfile = dispatchProfile("lifetime-profile", {
            displayName: "Lifetime fixture",
            avatarRevision: "lifetime-avatar",
          });
          return { profileId: "lifetime-profile", updatedAt: 1 };
        };
      }
      const dispatch = harness.dispatcher
        .dispatch(requestFrame("held", "test.lifetime"), client)
        .then(() => {
          dispatched = true;
          selection.OPENCLAW_STATE_DIR = restoredRoot;
        });
      await gate.during(
        dispatch,
        async () => {
          await nextTurn();
          expect.soft(dispatched, `${stage} is still executing`).toBe(false);
          expect([...harness.clients.authorityClients]).toEqual([client]);
        },
        Promise.all([finished.promise, dispatch]),
      );
      expect(selectedRoot).toBe(initialRoot);
      expect(dispatched).toBe(true);
      expect([...harness.clients.authorityClients]).toEqual([]);
    },
  );
});
