import { describe, expect, it } from "vitest";
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
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.admin"],
    },
    connectionSignal: connection.signal,
    preparedSessionProfile: {
      profileId: "fixture-operator",
      role: null,
      aliases: new Set(["fixture-operator"]),
    },
    internal: { operatorRoleActor: { kind: "operator", profileId: "fixture-operator" } },
  };
  const device = captureGatewayDeviceRevocation(
    context,
    { deviceId: "fixture-device", role: "operator" },
    () => !client.invalidated && !connection.signal.aborted,
    connection.signal,
    { isCurrent: () => sourceCurrent, subscribe: () => () => {} },
  );
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
    device,
    disconnect: () => {
      client.invalidated = true;
      connection.abort();
      invocation.abort();
      device.release();
    },
    revokeDevice: () => invalidateGatewayDeviceRevocation(context, "fixture-device", "operator"),
    revokeRole: () => {
      config = roleConfig([]);
    },
    revokeSource: () => {
      sourceCurrent = false;
    },
  };
}

describe("retained Gateway mutation authority", () => {
  it.each(["disconnect", "device revocation", "role revocation", "source revocation"] as const)(
    "rechecks the original grant after %s while work is pending",
    async (change) => {
      const fixture = requestFixture();
      const authority = retainGatewayRequestMutationAuthority(fixture.handler);
      try {
        // Durable setup runs after asynchronous discovery and can outlive its socket.
        await Promise.resolve();
        fixture.disconnect();
        if (change === "device revocation") {
          fixture.revokeDevice();
        } else if (change === "role revocation") {
          fixture.revokeRole();
        } else if (change === "source revocation") {
          fixture.revokeSource();
        }
        if (change === "disconnect") {
          expect(authority.assertCurrent).not.toThrow();
        } else {
          expect(authority.assertCurrent).toThrow(SessionMutationAuthorizationChangedError);
        }
      } finally {
        authority.release();
        fixture.device.release();
      }
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
    const authority = retainGatewayRequestMutationAuthority(request);
    try {
      expect(authority.assertCurrent).not.toThrow();
      current = false;
      expect(authority.assertCurrent).toThrow("Opaque caller grant expired");
    } finally {
      authority.release();
      fixture.device.release();
    }
  });

  it("rejects a grant revoked before it can be retained", () => {
    const fixture = requestFixture();
    fixture.revokeDevice();
    try {
      expect(() => retainGatewayRequestMutationAuthority(fixture.handler)).toThrow(
        "Gateway requester authority changed",
      );
    } finally {
      fixture.device.release();
    }
  });
});
