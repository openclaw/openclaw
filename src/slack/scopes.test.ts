import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSlackScopes } from "./scopes.js";

// Track all apiCall invocations so we can assert per-method behaviour.
const apiCallMock = vi.fn();

vi.mock("./client.js", () => ({
  createSlackWebClient: () => ({ apiCall: apiCallMock }),
}));

describe("fetchSlackScopes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns scopes from auth.scopes when available", async () => {
    apiCallMock.mockResolvedValueOnce({ ok: true, scopes: ["chat:write", "channels:read"] });

    const result = await fetchSlackScopes("xoxb-token", 5000);
    expect(result.ok).toBe(true);
    expect(result.scopes).toEqual(["channels:read", "chat:write"]);
    expect(result.source).toBe("auth.scopes");
    expect(apiCallMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to apps.permissions.info when auth.scopes fails", async () => {
    apiCallMock
      .mockResolvedValueOnce({ ok: false, error: "unknown_method" })
      .mockResolvedValueOnce({
        ok: true,
        info: { scopes: ["chat:write"] },
      });

    const result = await fetchSlackScopes("xoxb-token", 5000);
    expect(result.ok).toBe(true);
    expect(result.scopes).toEqual(["chat:write"]);
    expect(result.source).toBe("apps.permissions.info");
    expect(apiCallMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to auth.test response_metadata.scopes when first two methods fail", async () => {
    apiCallMock
      .mockResolvedValueOnce({ ok: false, error: "unknown_method" })
      .mockResolvedValueOnce({ ok: false, error: "unknown_method" })
      .mockResolvedValueOnce({
        ok: true,
        user_id: "U123",
        team_id: "T123",
        response_metadata: { scopes: ["chat:write", "reactions:read"] },
      });

    const result = await fetchSlackScopes("xoxb-token", 5000);
    expect(result.ok).toBe(true);
    expect(result.scopes).toEqual(["chat:write", "reactions:read"]);
    expect(result.source).toBe("auth.test");
    expect(apiCallMock).toHaveBeenCalledTimes(3);
    expect(apiCallMock).toHaveBeenNthCalledWith(1, "auth.scopes");
    expect(apiCallMock).toHaveBeenNthCalledWith(2, "apps.permissions.info");
    expect(apiCallMock).toHaveBeenNthCalledWith(3, "auth.test");
  });

  it("returns error when all three methods fail", async () => {
    apiCallMock
      .mockResolvedValueOnce({ ok: false, error: "unknown_method" })
      .mockResolvedValueOnce({ ok: false, error: "unknown_method" })
      .mockResolvedValueOnce({ ok: false, error: "invalid_auth" });

    const result = await fetchSlackScopes("xoxb-token", 5000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("auth.scopes");
    expect(result.error).toContain("apps.permissions.info");
    expect(result.error).toContain("auth.test");
  });

  it("handles thrown errors gracefully", async () => {
    apiCallMock
      .mockRejectedValueOnce(new Error("network error"))
      .mockRejectedValueOnce(new Error("network error"))
      .mockRejectedValueOnce(new Error("network error"));

    const result = await fetchSlackScopes("xoxb-token", 5000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("network error");
  });

  it("extracts scopes from response_metadata.acceptedScopes", async () => {
    apiCallMock
      .mockResolvedValueOnce({ ok: false, error: "unknown_method" })
      .mockResolvedValueOnce({ ok: false, error: "unknown_method" })
      .mockResolvedValueOnce({
        ok: true,
        response_metadata: { acceptedScopes: ["chat:write"] },
      });

    const result = await fetchSlackScopes("xoxb-token", 5000);
    expect(result.ok).toBe(true);
    expect(result.scopes).toEqual(["chat:write"]);
    expect(result.source).toBe("auth.test");
  });
});
