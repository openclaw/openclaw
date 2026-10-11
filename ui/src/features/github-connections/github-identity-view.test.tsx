import { nothing, render } from "lit";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { GitHubIdentityController } from "./github-identity-controller.ts";
import { renderGitHubIdentity } from "./github-identity-view.ts";
import { GitHubConnectionSetup } from "./github-identity-view.tsx";

const writeText = vi.fn<(text: string) => Promise<void>>();
const fallback = vi.fn(() => true);
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  fallback.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: fallback });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
  if (execCommandDescriptor) {
    Object.defineProperty(document, "execCommand", execCommandDescriptor);
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
});

describe("GitHub identity view", () => {
  it("retires pending authorization-code copying only when its payload changes", async () => {
    const pending = createDeferred();
    writeText.mockReturnValueOnce(pending.promise);
    const [revision, setRevision] = createSignal(0);
    const controller = new GitHubIdentityController({ requestUpdate: vi.fn() });
    controller.statusReadable = controller.authorizable = true;
    vi.spyOn(controller, "connectionReady", "get").mockReturnValue(true);
    let userCode = "first";
    let phase: "code" | "pending" = "code";
    vi.spyOn(controller, "authorization", "get").mockImplementation(() => ({
      phase,
      requestId: "github-device-test",
      userCode,
      verificationUri: "https://github.com/login/device",
      expiresInMs: 60_000,
      pollAfterMs: 5_000,
      displayExpiresAtMs: 70_000,
    }));
    const readController = () => {
      revision();
      return controller;
    };
    const view = mountSolid(() => <GitHubConnectionSetup controller={readController()} />);
    const button = view.container.querySelector<HTMLButtonElement>(".github-device-code + button")!;
    button.click();
    expect(writeText).toHaveBeenCalledOnce();
    phase = "pending";
    setRevision(1);
    flush();
    expect(view.container.querySelector(".github-device-code + button")).toBe(button);
    expect(view.getByText("Waiting for approval…")).toBeTruthy();
    userCode = "second";
    setRevision(2);
    flush();
    const current = view.container.querySelector<HTMLButtonElement>(
      ".github-device-code + button",
    )!;
    expect(current).not.toBe(button);
    expect(current.disabled).toBe(false);
    pending.reject(new Error("Synthetic clipboard rejection"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fallback).not.toHaveBeenCalled();
    expect(current.dataset.copyState).toBeUndefined();
    current.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText.mock.calls.map(([text]) => text)).toEqual(["first", "second"]);
    expect(current.dataset.copyState).toBe("copied");
  });

  it("keeps the Lit caller's focused PAT field across same-controller redraws", async () => {
    const owner = document.body.appendChild(document.createElement("section"));
    const onOpenConnections = vi.fn();
    const controller = new GitHubIdentityController({ requestUpdate: () => redraw() });
    controller.configurable = controller.patVisible = true;
    const redraw = () => render(renderGitHubIdentity(controller, onOpenConnections), owner);
    try {
      redraw();
      const bridge = owner.querySelector<SolidBridgeElement<object>>("openclaw-github-identity")!;
      await bridge.updateComplete;
      const input = owner.querySelector<HTMLInputElement>(".settings-secret input")!;
      input.focus();
      input.value = "synthetic-pat";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await bridge.updateComplete;
      expect(controller.draft.token).toBe("synthetic-pat");
      expect(owner.querySelector(".settings-secret input")).toBe(input);
      expect(document.activeElement).toBe(input);
      controller.busy = true;
      redraw();
      await bridge.updateComplete;
      expect(input.disabled).toBe(true);
      expect(input.value).toBe("synthetic-pat");
      expect(owner.querySelector(".settings-secret input")).toBe(input);
    } finally {
      render(nothing, owner);
      owner.remove();
      await Promise.resolve();
    }
  });
});
