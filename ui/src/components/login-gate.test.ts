/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import "./login-gate.ts";

type LoginGateElement = HTMLElement & {
  props: Record<string, unknown>;
  updateComplete: Promise<unknown>;
};

afterEach(() => document.body.replaceChildren());

describe("LoginGate protocol mismatch", () => {
  function props(overrides: Record<string, unknown> = {}) {
    const documentUrl = new URL(window.location.href);
    documentUrl.protocol = documentUrl.protocol === "https:" ? "wss:" : "ws:";
    return {
      basePath: "",
      connected: false,
      lastError: "protocol mismatch",
      lastErrorCode: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
      hasToken: false,
      hasPassword: false,
      gatewayUrl: documentUrl.href,
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
      ...overrides,
    };
  }

  async function mount(overrides: Record<string, unknown> = {}) {
    const gate = document.createElement("openclaw-login-gate") as LoginGateElement;
    gate.props = props(overrides);
    document.body.append(gate);
    await gate.updateComplete;
    return gate;
  }

  it("keeps reconnect controls beside the primary same-origin refresh recovery", async () => {
    const onConnect = vi.fn();
    const gate = await mount({ onConnect });

    const screen = gate.querySelector('[data-kind="protocol-mismatch"]');
    expect(screen?.textContent).toContain("This app is out of date");
    expect(screen?.textContent).toContain("Refresh to load the Control UI served by this Gateway");
    expect(screen?.querySelector(".login-gate__protocol-refresh")).not.toBeNull();
    expect(screen?.querySelector(".login-gate__form")).not.toBeNull();
    screen?.querySelector<HTMLButtonElement>(".login-gate__form .login-gate__connect")?.click();
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it("emphasizes choosing a compatible gateway for a cross-origin mismatch", async () => {
    const gate = await mount({ gatewayUrl: "wss://gateway.example.test" });
    const screen = gate.querySelector('[data-kind="protocol-mismatch"]');

    expect(screen?.textContent).toContain("This UI came from a different origin");
    expect(screen?.textContent).toContain("Choose a compatible Gateway URL below");
    expect(
      screen?.querySelector<HTMLInputElement>('.login-gate__form input[inputmode="url"]'),
    ).toHaveProperty("value", "wss://gateway.example.test");
  });
});
