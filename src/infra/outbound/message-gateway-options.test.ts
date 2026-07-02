// Covers outbound gateway option defaults, timeout clamping, and backend URL
// suppression.
import { describe, expect, it } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../../shared/number-coercion.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import {
  DEFAULT_OUTBOUND_MESSAGE_GATEWAY_TIMEOUT_MS,
  resolveOutboundMessageGatewayOptions,
} from "./message-gateway-options.js";

describe("resolveOutboundMessageGatewayOptions", () => {
  it("waits long enough for bounded provider sends to finish", () => {
    expect(resolveOutboundMessageGatewayOptions().timeoutMs).toBe(
      DEFAULT_OUTBOUND_MESSAGE_GATEWAY_TIMEOUT_MS,
    );
  });

  it("clamps oversized gateway timeouts", () => {
    expect(
      resolveOutboundMessageGatewayOptions({ timeoutMs: Number.MAX_SAFE_INTEGER }).timeoutMs,
    ).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("drops caller-provided urls for backend gateway callers", () => {
    expect(
      resolveOutboundMessageGatewayOptions({
        url: "http://attacker.invalid",
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      }).url,
    ).toBeUndefined();
  });
});
