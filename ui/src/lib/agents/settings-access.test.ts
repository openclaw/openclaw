// @vitest-environment node
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import { resolveAgentSettingsReadFailure } from "./settings-access.ts";

it.each([
  [
    new GatewayProtocolRequestError({ code: "FORBIDDEN", message: "No access", retryable: true }),
    "denied",
    false,
  ],
  [
    new GatewayProtocolRequestError({
      code: "INVALID_REQUEST",
      message: "No access",
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.read",
        requiredScopes: ["operator.read"],
      },
    }),
    "denied",
    false,
  ],
  [new GatewayProtocolRequestError({ code: "UNAVAILABLE", retryable: true }), "failed", true],
  [new GatewayProtocolRequestError({ code: "UNAVAILABLE", retryable: false }), "failed", false],
  [new Error("missing scope: operator.read"), "failed", false],
] as const)(
  "classifies the admitted failure without retrying a denial (%s)",
  (error, state, retryable) => {
    expect(resolveAgentSettingsReadFailure(error)).toEqual({ state, retryable });
  },
);
