import { describe, expect, it } from "vitest";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import {
  consumeAcceptedPluginGatewayHandoffClaim,
  withAcceptedPluginGatewayHandoffClaim,
  type AcceptedPluginGatewayHandoffClaim,
} from "./plugin-tool-handoff-claim.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

function fixture() {
  let current = true;
  let dispatchedCurrent = true;
  const source = {};
  const operatorAuthority = {
    profileId: "alice",
    source,
    scopes: ["operator.read", "operator.write"],
    assertCurrent() {
      if (!current) {
        throw new Error("operator source revoked");
      }
    },
  } as AdmittedRunOperatorAuthority;
  const dispatchedAuthority = {
    profileId: "alice",
    source,
    scopes: ["operator.sessions.write"],
    assertCurrent() {
      if (!dispatchedCurrent) {
        throw new Error("dispatched authority revoked");
      }
    },
  } as AdmittedRunOperatorAuthority;
  const params = { sessionKey: "agent:main:personal", title: "Draft" };
  const method = "tools.example.publication.publish";
  const claim: AcceptedPluginGatewayHandoffClaim = {
    pluginId: "example",
    toolName: "example_publish",
    method,
    params,
    agentId: "main",
    sessionKey: params.sessionKey,
    sessionId: "session-1",
    operatorAuthority,
    signal: new AbortController().signal,
    assertCurrent: () => operatorAuthority.assertCurrent(),
  };
  const options = {
    req: { method },
    params: { ...params },
    client: { internal: { syntheticClient: true, operatorRunAuthority: dispatchedAuthority } },
  } as unknown as GatewayRequestHandlerOptions;
  return {
    claim,
    options,
    revoke: () => (current = false),
    revokeDispatched: () => (dispatchedCurrent = false),
  };
}

describe("accepted plugin Gateway handoff claim", () => {
  const expected = { pluginId: "example", toolName: "example_publish" };

  it("admits exactly one matching synthetic dispatch", () => {
    const { claim, options } = fixture();
    withAcceptedPluginGatewayHandoffClaim(claim, () => {
      expect(consumeAcceptedPluginGatewayHandoffClaim(options, expected)).toBe(claim);
      expect(() => consumeAcceptedPluginGatewayHandoffClaim(options, expected)).toThrow(
        "no accepted plugin tool handoff",
      );
    });
    expect(() => consumeAcceptedPluginGatewayHandoffClaim(options, expected)).toThrow(
      "no accepted plugin tool handoff",
    );
  });

  it("rejects method, params, tool and operator-source substitution", () => {
    const { claim, options } = fixture();
    withAcceptedPluginGatewayHandoffClaim(claim, () => {
      expect(() =>
        consumeAcceptedPluginGatewayHandoffClaim(
          { ...options, req: { ...options.req, method: "tools.example.publication.confirm" } },
          expected,
        ),
      ).toThrow();
      expect(() =>
        consumeAcceptedPluginGatewayHandoffClaim(
          { ...options, params: { ...options.params, title: "Changed" } },
          expected,
        ),
      ).toThrow();
      expect(() =>
        consumeAcceptedPluginGatewayHandoffClaim(options, {
          ...expected,
          toolName: "other_tool",
        }),
      ).toThrow();
      expect(() =>
        consumeAcceptedPluginGatewayHandoffClaim(
          {
            ...options,
            client: {
              ...options.client!,
              internal: { ...options.client!.internal, operatorRunAuthority: {} },
            },
          } as GatewayRequestHandlerOptions,
          expected,
        ),
      ).toThrow();
      expect(() =>
        consumeAcceptedPluginGatewayHandoffClaim(
          {
            ...options,
            client: {
              ...options.client!,
              internal: {
                ...options.client!.internal,
                operatorRunAuthority: {
                  ...options.client!.internal!.operatorRunAuthority!,
                  source: {},
                },
              },
            },
          } as GatewayRequestHandlerOptions,
          expected,
        ),
      ).toThrow();
      expect(() =>
        consumeAcceptedPluginGatewayHandoffClaim(
          {
            ...options,
            client: {
              ...options.client!,
              internal: {
                ...options.client!.internal,
                operatorRunAuthority: {
                  ...options.client!.internal!.operatorRunAuthority!,
                  profileId: "bob",
                },
              },
            },
          } as GatewayRequestHandlerOptions,
          expected,
        ),
      ).toThrow();
      expect(consumeAcceptedPluginGatewayHandoffClaim(options, expected)).toBe(claim);
    });
  });

  it("rejects a revoked retained source before a provider effect", () => {
    const { claim, options, revoke } = fixture();
    withAcceptedPluginGatewayHandoffClaim(claim, () => {
      revoke();
      expect(() => consumeAcceptedPluginGatewayHandoffClaim(options, expected)).toThrow(
        "operator source revoked",
      );
    });
  });

  it("rejects a revoked projected dispatch authority", () => {
    const { claim, options, revokeDispatched } = fixture();
    withAcceptedPluginGatewayHandoffClaim(claim, () => {
      revokeDispatched();
      expect(() => consumeAcceptedPluginGatewayHandoffClaim(options, expected)).toThrow(
        "dispatched authority revoked",
      );
    });
  });
});
