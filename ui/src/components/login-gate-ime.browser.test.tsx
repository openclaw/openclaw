/* @vitest-environment browser */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flush } from "../test-helpers/solid-settle.ts";
import { mountFailure } from "./login-gate.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("login gate IME composition (real Chromium)", () => {
  it("does not connect while an IME candidate is composing in the secret field", async () => {
    const element = await mountFailure("", null);
    const input = element.querySelector<HTMLInputElement>("#login-gate-credential")!;
    element.props = { ...element.props, secret: "draft", showGatewaySecret: true };
    await element.updateComplete;
    input.value = "draft";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
    );
    flush();
    expect(element.props.onConnect).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flush();
    expect(element.props.onConnect).toHaveBeenCalledOnce();
  });

  it("keeps IME composition from connecting from the Gateway URL field", async () => {
    const element = await mountFailure("", null);
    const input = element.querySelector<HTMLInputElement>("#login-gate-url")!;
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, keyCode: 229 }),
    );
    flush();
    expect(element.props.onConnect).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flush();
    expect(element.props.onConnect).toHaveBeenCalledOnce();
  });
});
