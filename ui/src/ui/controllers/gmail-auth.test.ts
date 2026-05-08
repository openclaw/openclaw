/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadGmailAuthStatus,
  maybeCompleteGmailOAuthRedirect,
  type GmailAuthState,
} from "./gmail-auth.ts";

function createState(overrides: Partial<GmailAuthState> = {}): GmailAuthState {
  return {
    client: {
      request: vi.fn(),
    } as unknown as GmailAuthState["client"],
    connected: true,
    gmailAuthLoading: false,
    gmailAuthConnectPending: false,
    gmailAuthStatus: null,
    gmailAuthError: null,
    ...overrides,
  };
}

describe("gmail auth controller", () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, "", "http://localhost:3000/overview");
  });

  it("loads gmail auth status from the gateway", async () => {
    const state = createState();
    const request = vi.mocked(state.client!.request);
    request.mockResolvedValue({
      providerId: "google-gmail",
      connected: true,
      profiles: [{ profileId: "google-gmail:david@example.com", email: "david@example.com" }],
    });

    await loadGmailAuthStatus(state);

    expect(request).toHaveBeenCalledWith("gmail.auth.status", {});
    expect(state.gmailAuthStatus?.connected).toBe(true);
    expect(state.gmailAuthStatus?.profiles[0]?.email).toBe("david@example.com");
  });

  it("completes a gmail oauth redirect and clears the callback params", async () => {
    window.history.replaceState(
      {},
      "",
      "http://localhost:3000/overview?code=code-123&state=state-123&scope=email",
    );
    sessionStorage.setItem(
      "openclaw:gmail-oauth:pending",
      JSON.stringify({
        state: "state-123",
        verifier: "verifier-123",
        redirectUri: "http://localhost:3000/overview",
        createdAt: Date.now(),
      }),
    );
    const state = createState();
    const request = vi.mocked(state.client!.request);
    request
      .mockResolvedValueOnce({
        providerId: "google-gmail",
        profileId: "google-gmail:david@example.com",
      })
      .mockResolvedValueOnce({
        providerId: "google-gmail",
        connected: true,
        profiles: [{ profileId: "google-gmail:david@example.com", email: "david@example.com" }],
      });

    const completed = await maybeCompleteGmailOAuthRedirect(state);

    expect(completed).toBe(true);
    expect(request).toHaveBeenNthCalledWith(1, "gmail.auth.exchange", {
      code: "code-123",
      verifier: "verifier-123",
      redirectUri: "http://localhost:3000/overview",
    });
    expect(request).toHaveBeenNthCalledWith(2, "gmail.auth.status", {});
    expect(window.location.search).toBe("");
    expect(sessionStorage.getItem("openclaw:gmail-oauth:pending")).toBeNull();
  });
});
