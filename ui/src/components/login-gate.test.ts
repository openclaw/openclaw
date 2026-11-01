/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes as Codes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { registerControlUiReloadGuard } from "../app/document-reload-guard.ts";
import { showToast } from "../lib/toast.ts";
import { gatePart as part, mountFailure } from "./login-gate.test-support.ts";

function expectText(root: ParentNode | null | undefined, selector: string, trim = false) {
  const text = root?.querySelector(
    selector.startsWith(".") ? selector : `.login-gate__${selector}`,
  )?.textContent;
  return expect(trim ? text?.trim() : text);
}
function clipboard(writeText = vi.fn().mockResolvedValue(undefined), fallback = false) {
  const execCommand = vi.fn(() => false);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  if (fallback) {
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  }
  return { writeText, execCommand };
}
function copyControls(element: HTMLElement) {
  const command = part(element, "command");
  return {
    command,
    button: command.querySelector<HTMLButtonElement>(".chat-copy-btn")!,
    status: command.querySelector<HTMLElement>('[role="status"]')!,
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "execCommand");
});

describe("login gate failure recovery", () => {
  const setupCode = btoa(
    JSON.stringify({
      url: "wss://gateway.example",
      bootstrapToken: "synthetic-bootstrap-token",
    }),
  ).replace(/=+$/g, "");

  it("pauses the busy countdown while hidden and catches up on return and reconnect", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const element = await mountFailure("Gateway busy", "GATEWAY_BUSY");
    element.props = { ...element.props, reconnectPending: true, reconnectAt: Date.now() + 5_000 };
    await element.updateComplete;
    const countdown = () => element.querySelector(".login-gate__retry")?.textContent;
    expect(countdown()).toBe("Retrying in 5s…");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(countdown()).toBe("Retrying in 4s…");
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(countdown()).toBe("Retrying in 4s…");
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await element.updateComplete;
    expect(countdown()).toBe("Retrying in 2s…");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(countdown()).toBe("Retrying now…");

    element.props = { ...element.props, reconnectAt: Date.now() + 5_000 };
    await element.updateComplete;
    expect(countdown()).toBe("Retrying in 5s…");
    element.remove();
    await vi.advanceTimersByTimeAsync(1_000);
    document.body.append(element);
    await element.updateComplete;
    expect(countdown()).toBe("Retrying in 4s…");
  });

  it("drags only the empty native background and preserves login recovery controls", async () => {
    const postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { openclawWindowDrag: { postMessage } } });
    const element = await mountFailure("unauthorized", Codes.AUTH_TOKEN_MISSING);
    const onOpenGatewaySettings = vi.fn();
    element.props = { ...element.props, onOpenGatewaySettings };
    await element.updateComplete;
    const press = (target: Element) => {
      const event = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
      });
      target.dispatchEvent(event);
      return event;
    };

    expect(press(element.querySelector(".login-gate")!).defaultPrevented).toBe(true);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "window-drag" });

    for (const selector of [
      ".login-gate__card",
      ".login-gate__failure-title",
      ".login-gate__failure-summary",
      "#login-gate-url",
      ".login-gate__connect",
      ".login-gate__recovery button",
    ]) {
      expect(press(element.querySelector(selector)!).defaultPrevented).toBe(false);
    }
    expect(postMessage).toHaveBeenCalledOnce();

    part(element, "recovery button").click();
    expect(onOpenGatewaySettings).toHaveBeenCalledOnce();
    part(element, "connect").click();
    expect(element.props.onConnect).toHaveBeenCalledOnce();
  });

  it("explains setup codes instead of generic mismatch copy", async () => {
    const element = await mountFailure("unauthorized", Codes.AUTH_TOKEN_MISMATCH, setupCode);
    expectText(element, "failure-summary", true).toBe(
      element.querySelector("#login-gate-secret-hint")?.textContent?.trim(),
    );
    expectText(element, "failure-summary").toContain(
      "Paste it in the app's Gateway settings instead",
    );
  });

  it("preserves unrelated failure summaries with a setup code entered", async () => {
    const element = await mountFailure("rate limit", Codes.AUTH_RATE_LIMITED, setupCode);
    expect(part(element, "failure").dataset.kind).toBe("auth-rate-limited");
    expectText(element, "failure-summary").not.toContain("device setup code");
  });

  it("explains how to reconnect with a verified user identity", async () => {
    const element = await mountFailure("unauthorized", Codes.AUTH_VERIFIED_USER_REQUIRED);
    expect(part(element, "failure").dataset.kind).toBe("verified-user-required");
    expectText(element, "failure-title").toBe("Verified identity required");
    expectText(element, "failure-steps").toMatch(/trusted proxy or Tailscale/iu);
    expectText(element, "failure-steps").toMatch(/shared Gateway token or password/iu);
    expect(part(element, "failure-docs").getAttribute("href")).toBe(
      "https://docs.openclaw.ai/gateway/operator-scopes",
    );
  });

  it("explains missing identity headers even with credentials entered", async () => {
    const element = await mountFailure(
      "unauthorized",
      Codes.AUTH_IDENTITY_HEADER_REQUIRED,
      "secret",
    );
    const failure = part(element, "failure");
    const steps = part(failure, "failure-steps").textContent;
    expect(failure.dataset.kind).toBe("trusted-proxy");
    expectText(failure, "failure-raw").toBe("unauthorized");
    expect(failure.querySelectorAll(".login-gate__failure-steps code")).toHaveLength(0);
    expect(steps).toMatch(/(?:open|use|sign in).*?(?:authenticated proxy|SSO).*?URL/iu);
    expect(part(failure, "failure-docs").getAttribute("href")).toBe(
      "https://docs.openclaw.ai/gateway/trusted-proxy-auth",
    );
    expect(steps).toMatch(/configured/iu);
    expect(element.querySelector(".login-gate__failure")?.textContent).toMatch(
      /missing.*?identity[- ]headers?|identity[- ]headers?.*?missing/iu,
    );
    expect(steps).toMatch(/forward/iu);
    expect(steps).toMatch(/WebSocket upgrade/iu);
    expect(steps).not.toMatch(/generate.*?token|replace.*?(?:token|password)|Gateway is running/iu);
  });

  it("explains profile verification failures without credential or network recovery", async () => {
    const error = "Profile verification unavailable";
    const element = await mountFailure(error, Codes.AUTHENTICATED_PROFILE_UNAVAILABLE);
    expect(part(element, "failure").dataset.kind).toBe("profile-unavailable");
    expectText(element, "failure-title").toBe("Couldn't verify your account");
    expectText(element, "failure-summary").toBe(
      "OpenClaw couldn't check your account right now. Please try again shortly.",
    );
    expectText(element, "failure-steps").toContain("Retry");
    expectText(element, "failure-steps").toContain("person who manages OpenClaw");
    expect(part(element, "failure-steps").querySelectorAll("code")).toHaveLength(0);
    expectText(element, "failure-raw").toBe(error);
  });

  it("explains operator access denial without credential or network recovery", async () => {
    const element = await mountFailure("access denied", Codes.OPERATOR_ACCESS_DENIED);
    const failure = part(element, "failure");
    expect(failure.dataset).toMatchObject({ kind: "access-denied", tone: "warn" });
    expectText(failure, "failure-title").toBe("No access to this Gateway");
    expectText(failure, "failure-steps").toContain(
      "Ask a Gateway administrator to assign your profile a role",
    );
    expect(part(failure, "failure-steps").querySelector("code")?.textContent).toBe(
      "openclaw users list --json",
    );
    expect(part(failure, "failure-docs").getAttribute("href")).toBe(
      "https://docs.openclaw.ai/gateway/operator-scopes#named-operator-roles",
    );
    expect(failure.textContent).not.toMatch(/openclaw gateway run|Gateway unreachable/u);
    expectText(failure, "failure-steps").toContain(
      "This page reconnects on its own once access is granted.",
    );
    expectText(failure, "failure-steps").not.toMatch(
      /Gateway is running|Gateway URL|token|password/iu,
    );
  });

  it("recovers an invalid one-time pairing link without blaming the Gateway secret", async () => {
    const element = await mountFailure(
      "unauthorized: bootstrap token invalid",
      Codes.AUTH_BOOTSTRAP_TOKEN_INVALID,
    );
    const failure = part(element, "failure");
    expectText(failure, "failure-title", true).toBe("Pairing link is no longer valid");
    expectText(failure, "failure-summary").toMatch(/expired|already been used/);
    expectText(failure, "command--hero code", true).toBe("openclaw dashboard");
    const steps = part(failure, "failure-steps");
    expect(steps?.textContent).toContain("browserUrl");
    expect(steps.querySelector("code")?.textContent?.trim()).toBe("openclaw dashboard --json");
    expect(failure?.textContent).not.toMatch(/Gateway secret rejected|Replace the Gateway secret/);
    expect(element.props.onConnect).not.toHaveBeenCalled();
  });

  it("edits and reveals one Gateway secret without choosing a credential type", async () => {
    const element = await mountFailure("", null, "old-secret");
    const input = element.querySelector<HTMLInputElement>("#login-gate-credential")!;
    expect(element.querySelector('label[for="login-gate-credential"]')?.textContent).toBe(
      "Gateway secret",
    );
    expect(input).toMatchObject({
      placeholder: "Paste the token or type the password",
      type: "password",
      value: "old-secret",
    });
    expect(element.querySelector('[role="radiogroup"]')).toBeNull();

    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    element.props = { ...element.props, secret: "" };
    await element.updateComplete;
    input.value = "replacement-secret";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(element.props.onSecretChange).toHaveBeenNthCalledWith(1, "");
    expect(element.props.onSecretChange).toHaveBeenNthCalledWith(2, "replacement-secret");

    element
      .querySelector<HTMLButtonElement>('[aria-label="Toggle Gateway secret visibility"]')
      ?.click();
    expect(element.props.onToggleGatewaySecret).toHaveBeenCalledOnce();
    element.props = { ...element.props, secret: "replacement-secret", showGatewaySecret: true };
    await element.updateComplete;
    expect(input).toMatchObject({ type: "text", value: "replacement-secret" });
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(element.props.onConnect).toHaveBeenCalledOnce();
  });

  it("explains a password mismatch without changing the input or suggesting token recovery", async () => {
    const element = await mountFailure(
      "unauthorized",
      Codes.AUTH_PASSWORD_MISMATCH,
      "entered-secret",
    );
    expect(part(element, "failure").dataset.kind).toBe("auth-failed");
    expectText(element, "failure-title", true).toBe("This Gateway expects its password");
    expectText(element, "failure-steps").toContain(
      "Type the configured Gateway password into Gateway secret.",
    );
    expect(element.querySelector<HTMLInputElement>("#login-gate-credential")?.value).toBe(
      "entered-secret",
    );
    expectText(element, "failure-steps").not.toMatch(/auth-token|generate-gateway-token|auth mode/);
    expect(element.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it("offers page refresh and cache-busts only after the Gateway answers", async () => {
    const element = await mountFailure("protocol mismatch", Codes.PROTOCOL_MISMATCH);
    const replace = vi.fn();
    vi.stubGlobal("window", { location: { href: "https://gateway.example/chat", replace } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const failure = part(element, 'failure[data-kind="protocol-mismatch"]');
    const refresh = part(failure, "failure-refresh");

    expect(refresh?.textContent?.trim()).toBe("Refresh page");
    expect(part(failure, "failure-steps")).not.toBeNull();
    expect(part(failure, "failure-docs")).not.toBeNull();

    refresh?.click();
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
    expect(replace).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/gateway\.example\/chat\?openclaw_mount_recovery=\d+$/),
    );
  });

  it("shows an explicit recovery choice when reconnect leaves unsaved starts behind the login gate", async () => {
    const element = await mountFailure("protocol mismatch", Codes.PROTOCOL_MISMATCH);
    const reload = vi.fn();
    const discard = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    const release = registerControlUiReloadGuard(
      () => false,
      () => {
        showToast({
          message: "Recovery needs a reload. Unsaved starts will be lost.",
          actionLabel: "Discard unsaved starts and reload",
          onAction: discard,
        });
      },
    );
    try {
      part(element, "failure-refresh").click();
      expect(reload).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expectText(element, ".app-toast__message").toContain("Unsaved starts will be lost.");
      });
      const action = element.querySelector<HTMLButtonElement>(".app-toast__action");
      expect(action?.textContent?.trim()).toBe("Discard unsaved starts and reload");
      expect(discard).not.toHaveBeenCalled();
      action?.click();
      expect(discard).toHaveBeenCalledOnce();
    } finally {
      release();
    }
  });

  it("shows automatic pairing recovery only while reconnect is pending", async () => {
    const element = await mountFailure("pairing required", Codes.PAIRING_REQUIRED);
    element.props = { ...element.props, reconnectPending: true };
    await element.updateComplete;

    expect(element.textContent).toContain(
      "Waiting for approval… this page connects on its own once the request is approved.",
    );
    expect(element.textContent).not.toContain("Once approved, click Connect.");
    expect(element.querySelector('[aria-hidden="true"].session-run-spinner')).not.toBeNull();
    const checkNow = part(element, "connect");
    expect(checkNow.textContent?.trim()).toBe("Check now");
    checkNow.click();
    expect(element.props.onConnect).toHaveBeenCalledOnce();

    element.props = { ...element.props, reconnectPending: false };
    await element.updateComplete;
    expect(element.textContent).toContain("Once approved, click Connect.");
    expect(element.textContent).not.toContain("Waiting for approval…");
    expect(element.querySelector(".session-run-spinner")).toBeNull();
    expect(checkNow.textContent?.trim()).toBe("Connect");
  });

  it("renders only a normalized pairing request in the approve command", async () => {
    const safe = await mountFailure(
      "scope upgrade pending approval (requestId: req-123)",
      Codes.PAIRING_REQUIRED,
    );

    expectText(safe, "failure-title").toBe("Approve the new access level");
    expectText(safe, "command--hero code", true).toBe("openclaw devices approve req-123");
    expect(safe.querySelectorAll(".login-gate__failure-steps li")).toHaveLength(2);
    safe.remove();

    const unsafe = await mountFailure(
      "scope upgrade pending approval (requestId: req-123;touch-owned)",
      Codes.PAIRING_REQUIRED,
    );

    expectText(unsafe, "command--hero code", true).toBe("openclaw devices approve --latest");
    // Only the redacted raw-error disclosure may echo the rejected id.
    expectText(unsafe, "hero").not.toContain("touch-owned");
    expectText(unsafe, "failure-steps").not.toContain("touch-owned");
  });

  it("preserves command order when one recovery sentence contains multiple commands", async () => {
    const element = await mountFailure("WebSocket connection failed", null);
    expect(element.querySelector(".login-gate__failure-refresh")).toBeNull();

    expect(
      Array.from(element.querySelectorAll(".login-gate__failure-steps code"), (entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["openclaw status", "openclaw gateway run", "openclaw dashboard --no-open"]);
  });

  it("offers only supported recovery for an insecure browser context", async () => {
    const element = await mountFailure(
      "device identity required",
      Codes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
    );
    expect(element.querySelector(".login-gate__failure-refresh")).toBeNull();

    const steps = Array.from(
      element.querySelectorAll<HTMLElement>(".login-gate__failure-steps li"),
      (entry) => entry.textContent?.trim(),
    );
    expect(steps).toEqual([
      "Use HTTPS/Tailscale Serve, or open http://127.0.0.1:18789 on the Gateway host.",
      "Do not use a remote plain-HTTP URL; a token or password cannot replace browser device identity.",
    ]);
  });

  it("surfaces denied gateway-command copying from the Space key", async () => {
    const { writeText, execCommand } = clipboard(
      vi.fn().mockRejectedValue(new DOMException("Clipboard access denied")),
      true,
    );
    const element = await mountFailure("WebSocket connection failed", null);
    const { command, button, status } = copyControls(element);
    command.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: " " }),
    );

    await vi.waitFor(() => expect(button?.getAttribute("aria-label")).toBe("Copy failed"));
    expect(status.textContent).toBe("Copy failed");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("openclaw status");
    expect(execCommand).toHaveBeenCalledOnce();
  });

  it("keeps recovery command copy state isolated per button", async () => {
    const { writeText } = clipboard();
    const element = await mountFailure("WebSocket connection failed", null);
    const buttons = Array.from(
      element.querySelectorAll<HTMLButtonElement>(
        ".login-gate__failure-steps .login-gate__command .chat-copy-btn",
      ),
    );

    buttons[0]?.click();
    buttons[1]?.click();

    await vi.waitFor(() => {
      expect(buttons[0]?.getAttribute("aria-label")).toBe("Copied!");
      expect(buttons[1]?.getAttribute("aria-label")).toBe("Copied!");
    });
    expect(writeText.mock.calls).toEqual([["openclaw status"], ["openclaw gateway run"]]);
    expect(buttons[2]?.getAttribute("aria-label")).toBe("Copy command");
    element.props = { ...element.props, showGatewaySecret: true };
    await element.updateComplete;
    const retained = element.querySelectorAll<HTMLButtonElement>(
      ".login-gate__failure-steps .login-gate__command .chat-copy-btn",
    );
    for (const [index, button] of buttons.slice(0, 2).entries()) {
      expect(retained[index]).toBe(button);
      expect(retained[index]?.getAttribute("aria-label")).toBe("Copied!");
    }
  });

  it("keeps the latest command-copy feedback until its own reset", async () => {
    const { promise, resolve: finishCopy } = Promise.withResolvers<void>();
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("Clipboard access denied"))
      .mockReturnValueOnce(promise);
    const { execCommand } = clipboard(writeText, true);
    const schedule = vi.spyOn(window, "setTimeout");
    const element = await mountFailure("WebSocket connection failed", null);
    const { command, button, status } = copyControls(element);

    command?.click();
    await vi.waitFor(() => expect(button?.getAttribute("aria-label")).toBe("Copy failed"));
    const failedReset = schedule.mock.calls.find(([, delay]) => delay === 2_000)?.[0];
    if (typeof failedReset !== "function") {
      throw new Error("Expected the failed copy feedback to schedule its reset");
    }

    command?.click();
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-label")).toBe("Copy command");
    expect(status.hidden).toBe(true);
    failedReset();
    expect(status.hidden).toBe(true);
    finishCopy();
    await vi.waitFor(() => expect(button?.getAttribute("aria-label")).toBe("Copied!"));
    expect(status.hidden).toBe(false);

    failedReset();
    expect(button?.getAttribute("aria-label")).toBe("Copied!");
    expect(status.textContent).toBe("Copied!");

    const successfulReset = schedule.mock.calls.find(([, delay]) => delay === 1_500)?.[0];
    if (typeof successfulReset !== "function") {
      throw new Error("Expected the successful copy feedback to schedule its reset");
    }
    successfulReset();

    expect(button?.getAttribute("aria-label")).toBe("Copy command");
    expect(status.hidden).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(execCommand).toHaveBeenCalledOnce();
  });
});
