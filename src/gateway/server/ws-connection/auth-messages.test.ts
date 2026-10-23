import { expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { truncateCloseReason } from "../close-reason.js";
import { formatGatewayAuthFailureMessage } from "./auth-messages.js";

type MessageParams = Parameters<typeof formatGatewayAuthFailureMessage>[0];
const cli = { id: GATEWAY_CLIENT_IDS.CLI, mode: GATEWAY_CLIENT_MODES.CLI };
const node = { id: GATEWAY_CLIENT_IDS.NODE_HOST, mode: GATEWAY_CLIENT_MODES.NODE };
const setupRejected =
  "unauthorized: setup code invalid, expired, revoked, or already used (create a new code; review `openclaw devices list`)";
function format(params: Partial<MessageParams>) {
  return formatGatewayAuthFailureMessage({ authMode: "token", authProvided: "token", ...params });
}
function nodeRejection(reason: string): Partial<MessageParams> {
  return { authMode: "trusted-proxy", authProvided: "none", reason, client: node };
}

it.each(["token_redacted_config", "password_redacted_config"])(
  "names redaction corruption and its remedy for %s within the close limit",
  (reason) => {
    const message = format({ reason });
    expect(message).toContain("redaction sentinel");
    expect(message).toContain("openclaw doctor --fix");
    expect(truncateCloseReason(message)).toBe(message);
  },
);

it.each<[Partial<MessageParams>, string, boolean?, string?]>([
  [{ authProvided: "bootstrap-token", reason: "bootstrap_token_invalid" }, setupRejected, true],
  [{ authProvided: "bootstrap-token" }, setupRejected, true],
  [
    { authProvided: "device-token", reason: "scope_mismatch" },
    "unauthorized: device token scope mismatch (re-pair or approve scope upgrade)",
  ],
  [
    {
      authProvided: "none",
      reason: "token_missing",
      client: { id: GATEWAY_CLIENT_IDS.CONTROL_UI, mode: GATEWAY_CLIENT_MODES.WEBCHAT },
    },
    "unauthorized: gateway token missing (paste in Control UI settings or openclaw doctor --generate-gateway-token; restart)",
    true,
  ],
  [
    { reason: "token_mismatch", client: cli, isLocalClient: true },
    "unauthorized: gateway token mismatch (use this gateway's gateway.auth.token or pair the device)",
    true,
    "gateway.remote",
  ],
  [
    { reason: "token_mismatch", client: cli, isLocalClient: false },
    "unauthorized: gateway token mismatch (set gateway.remote.token to match gateway.auth.token)",
  ],
  [
    {
      authMode: "password",
      authProvided: "password",
      reason: "password_mismatch",
      client: cli,
      isLocalClient: true,
    },
    "unauthorized: gateway password mismatch (use this gateway's gateway.auth.password)",
  ],
  [
    nodeRejection("trusted_proxy_missing_header_cf-access-jwt-assertion"),
    "gateway rejected this node: trusted-proxy identity-header authentication is required and no usable machine credential was accepted; run `openclaw doctor` on the Gateway",
  ],
  [nodeRejection("trusted_proxy_local_interface_check_failed"), "unauthorized"],
])("formats an actionable auth failure for %j", (params, expected, closeLimit, excluded) => {
  const message = format(params);
  expect(message).toBe(expected);
  if (closeLimit) {
    expect(truncateCloseReason(message)).toBe(message);
  }
  if (excluded) {
    expect(message).not.toContain(excluded);
  }
});
