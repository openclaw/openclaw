/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { signOutOfRemoteOpenClawId } from "./remote-sign-out.ts";

// Model only the loader's public message/ack boundary; no live session is touched.
function loader(ok: boolean) {
  const assign = vi.fn();
  const close = vi.fn();
  let receive: ((event: MessageEvent) => void) | undefined;
  class Channel {
    port1 = {
      close,
      start: vi.fn(),
      removeEventListener: vi.fn(),
      addEventListener: (_event: string, handler: (event: MessageEvent) => void) => {
        receive = handler;
      },
    };
    port2 = { close };
  }
  const postMessage = vi.fn((message) => {
    expect(message).toEqual({ type: "ocl-signout" });
    queueMicrotask(() => receive?.({ data: { ok } } as MessageEvent));
  });
  vi.stubGlobal("MessageChannel", Channel);
  vi.stubGlobal("navigator", { serviceWorker: { controller: { postMessage } } });
  vi.stubGlobal("window", { setTimeout, clearTimeout, location: { assign } });
  return { assign, close, postMessage };
}

describe("remote account sign-out", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("waits for the loader acknowledgement and keeps its signed-out page from auto-signing-in", async () => {
    const { assign, close } = loader(true);
    await signOutOfRemoteOpenClawId();
    expect(close).toHaveBeenCalledTimes(2);
    expect(assign).toHaveBeenCalledWith("/_loader/?stay=1");
  });
  it("reports refusal without navigating or claiming sign-out", async () => {
    const { assign } = loader(false);
    await expect(signOutOfRemoteOpenClawId()).rejects.toThrow("could not sign out");
    expect(assign).not.toHaveBeenCalled();
  });
  it("refuses when no loader owns this page", async () => {
    vi.stubGlobal("navigator", {});
    await expect(signOutOfRemoteOpenClawId()).rejects.toThrow("remote session is unavailable");
  });
});
