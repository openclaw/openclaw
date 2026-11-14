import { expect, it, onTestFinished } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import { SharedGatewaySessionGenerationState } from "../server-shared-auth-generation.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  bindWebSocketRequestMutationAuthority,
  retainGatewayRequestMutationAuthority,
} from "./session-mutation-guards.js";
import { createSessionMutationTestClient } from "./sessions-mutations.owner.test-support.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestOptions } from "./types.js";

function roleConfig(scopes: "operator.admin"[] = ["operator.admin"]): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "maintainer",
        definitions: { maintainer: { scopes, agents: "*", sessions: { others: "write" } } },
      },
    },
  };
}

function requestFixture() {
  const connection = new AbortController();
  const invocation = new AbortController();
  let config = roleConfig();
  let sourceCurrent = true;
  const context = {
    getRuntimeConfig: () => config,
    getCommittedRuntimeConfig: () => config,
  } as GatewayRequestContext;
  const client: GatewayClient = {
    ...createSessionMutationTestClient(),
    connectionSignal: connection.signal,
    preparedSessionProfile: {
      profileId: "fixture-operator",
      role: null,
      aliases: new Set(["fixture-operator"]),
    },
    internal: { operatorRoleActor: { kind: "operator", profileId: "fixture-operator" } },
  };
  client.connect.scopes = ["operator.admin"];
  const device = captureGatewayDeviceRevocation(
    context,
    { deviceId: "fixture-device", role: "operator" },
    () => !client.invalidated && !connection.signal.aborted,
    connection.signal,
    { isCurrent: () => sourceCurrent, subscribe: () => () => {} },
  );
  onTestFinished(() => device.release());
  const request: GatewayRequestOptions = {
    req: { type: "req", id: "setup", method: "openclaw.setup.auto", params: {} },
    client,
    context,
    isWebchatConnect: () => true,
    respond: () => {},
    signal: invocation.signal,
    hasCurrentClientAuthority: device.isCurrent,
  };
  const generation = new SharedGatewaySessionGenerationState({
    current: undefined,
    required: null,
  });
  bindWebSocketRequestMutationAuthority(request, client as GatewayWsClient, generation.reader);
  const handler = bindGatewayRequestHandlerMutationAuthority(
    request,
    { ...request, params: {} },
    undefined,
  );
  return {
    handler,
    disconnect: () => {
      client.invalidated = true;
      connection.abort();
      invocation.abort();
      device.release();
    },
    revoke: {
      disconnect: () => {},
      "device revocation": () =>
        invalidateGatewayDeviceRevocation(context, "fixture-device", "operator"),
      "role revocation": () => {
        config = roleConfig([]);
      },
      "source revocation": () => {
        sourceCurrent = false;
      },
    },
  };
}

function retain(request: GatewayRequestOptions) {
  const authority = retainGatewayRequestMutationAuthority(request);
  onTestFinished(() => authority.release());
  return authority;
}

it.each(["disconnect", "device revocation", "role revocation", "source revocation"] as const)(
  "rechecks the original grant after %s while work is pending",
  async (change) => {
    const fixture = requestFixture();
    const authority = retain(fixture.handler);
    // Durable setup runs after asynchronous discovery and can outlive its socket.
    await Promise.resolve();
    fixture.disconnect();
    fixture.revoke[change]();
    if (change === "disconnect") {
      expect(authority.assertCurrent).not.toThrow();
    } else {
      expect(authority.assertCurrent).toThrow(SessionMutationAuthorizationChangedError);
    }
    authority.release();
    expect(authority.assertCurrent).toThrow(SessionMutationAuthorizationChangedError);
  },
);

it("preserves an opaque caller's original commit guard", () => {
  const fixture = requestFixture();
  let current = true;
  const request: GatewayRequestOptions = {
    ...fixture.handler,
    sessionMutationCommitGuard: () => {
      if (!current) {
        throw new Error("Opaque caller grant expired");
      }
    },
  };
  const authority = retain(request);
  expect(authority.assertCurrent).not.toThrow();
  current = false;
  expect(authority.assertCurrent).toThrow("Opaque caller grant expired");
});

it("rejects a grant revoked before it can be retained", () => {
  const fixture = requestFixture();
  fixture.revoke["device revocation"]();
  expect(() => retainGatewayRequestMutationAuthority(fixture.handler)).toThrow(
    "Gateway requester authority changed",
  );
});
