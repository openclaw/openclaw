import { expect, it } from "vitest";
import {
  acceptGatewayDeviceSourceAuthority,
  captureGatewayDeviceRevocation,
} from "./device-revocation.js";
import { captureRepositoryClientActor } from "./repository-dispatch.js";
import type { GatewayClient } from "./server-methods/client-types.js";

it.each([false, true])(
  "keeps only a natively accepted repository source across socket replacement (%s)",
  (accepted) => {
    const connection = new AbortController();
    let connected = true;
    let sourceCurrent = true;
    const source = captureGatewayDeviceRevocation({}, {}, () => connected, connection.signal, {
      isCurrent: () => sourceCurrent,
      subscribe: () => () => {},
    });
    const client: GatewayClient = {
      connId: "original-connection",
      connectionSignal: connection.signal,
      authenticatedUserProfile: {
        profileId: "original-profile",
        displayName: null,
        hasAvatar: false,
        updatedAt: 1,
      },
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "cli", mode: "cli", version: "test", platform: "test" },
        role: "operator",
        scopes: ["operator.write"],
      },
      internal: { authenticatedOperator: true },
    };
    try {
      const actor = captureRepositoryClientActor({
        client,
        hasCurrentClientAuthority: source.isCurrent,
        assertCurrent: () => {},
        claim: {
          purpose: "session-dispatch-project",
          binding: {
            kind: "session-dispatch",
            agentId: "main",
            sessionKey: "agent:main:original",
            sessionId: "original-physical-session",
            requestDigest: "original-dispatch",
          },
        },
      });
      if (accepted) {
        expect(acceptGatewayDeviceSourceAuthority(source.isCurrent)).toBe(true);
      }
      connected = false;
      client.invalidated = true;
      connection.abort();
      if (accepted) {
        expect(() => actor.assertCurrent()).not.toThrow();
        sourceCurrent = false;
      }
      expect(() => actor.assertCurrent()).toThrow("Repository caller authority changed");
    } finally {
      source.release();
    }
  },
);
