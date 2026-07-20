/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import "./login-gate.ts";

type LoginGateElement = HTMLElement & {
  props: Record<string, unknown>;
  updateComplete: Promise<unknown>;
};

afterEach(() => document.body.replaceChildren());

describe("LoginGate protocol mismatch", () => {
  it("renders a blocking refresh screen instead of reconnect controls", async () => {
    const gate = document.createElement("openclaw-login-gate") as LoginGateElement;
    gate.props = {
      basePath: "",
      connected: false,
      lastError: "protocol mismatch",
      lastErrorCode: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
      hasToken: false,
      hasPassword: false,
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      password: "",
      showGatewayToken: false,
      showGatewayPassword: false,
      onGatewayUrlChange: () => undefined,
      onTokenChange: () => undefined,
      onPasswordChange: () => undefined,
      onToggleGatewayToken: () => undefined,
      onToggleGatewayPassword: () => undefined,
      onConnect: () => undefined,
    };
    document.body.append(gate);
    await gate.updateComplete;

    const screen = gate.querySelector('[data-kind="protocol-mismatch"]');
    expect(screen?.textContent).toContain("This app is out of date — refresh to continue");
    expect(screen?.querySelector(".login-gate__protocol-refresh")).not.toBeNull();
    expect(screen?.querySelector(".login-gate__form")).toBeNull();
  });
});
