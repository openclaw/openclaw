/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { signOutOfRemoteOpenClawId } from "./remote-sign-out.ts";

// Model only the loader's public message/ack boundary; no live session is touched.
function loader(ok: boolean, logoutUrl?: string) {
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
    expect(message).toEqual({ type: "ocl-signout", endIssuer: true });
    queueMicrotask(() =>
      receive?.({ data: { ok, value: logoutUrl ? { logoutUrl } : undefined } } as MessageEvent),
    );
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
    const logout =
      "https://id.example.test/logout?return_to=https%3A%2F%2Fclaw.example.test%2F_loader%2F";
    const { assign, close } = loader(true, logout);
    await signOutOfRemoteOpenClawId();
    expect(close).toHaveBeenCalledTimes(2);
    expect(assign).toHaveBeenCalledWith(logout);
  });
  it("reports refusal without navigating or claiming sign-out", async () => {
    const { assign } = loader(false);
    await expect(signOutOfRemoteOpenClawId()).rejects.toThrow("could not finish sign-out");
    expect(assign).not.toHaveBeenCalled();
  });
  it("refuses when no loader owns this page", async () => {
    vi.stubGlobal("navigator", {});
    await expect(signOutOfRemoteOpenClawId()).rejects.toThrow("remote session is unavailable");
  });
  it("still ends the issuer session after an unconfirmed Gateway revocation", async () => {
    const logout =
      "https://id.example.test/logout?return_to=https%3A%2F%2Fclaw.example.test%2F_loader%2F";
    const { assign } = loader(false, logout);
    await signOutOfRemoteOpenClawId();
    expect(assign).toHaveBeenCalledWith(logout);
  });
  it("rejects an invalid issuer handoff instead of leaving the promise unsettled", async () => {
    loader(true, "not a URL");
    await expect(signOutOfRemoteOpenClawId()).rejects.toThrow("invalid sign-out address");
  });
});
