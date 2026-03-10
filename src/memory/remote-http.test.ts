import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { buildRemoteBaseUrlPolicy, withRemoteHttpResponse } from "./remote-http.js";

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

describe("remote-http", () => {
  const fetchWithSsrFGuardMock = vi.mocked(fetchWithSsrFGuard);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("buildRemoteBaseUrlPolicy", () => {
    it("returns policy for valid http/https URLs", () => {
      expect(buildRemoteBaseUrlPolicy(" https://memory.example:8080/v1 ")).toEqual({
        allowedHostnames: ["memory.example"],
      });
    });

    it("allows loopback and private operator hostnames", () => {
      expect(buildRemoteBaseUrlPolicy("http://127.0.0.1:3000")).toEqual({
        allowedHostnames: ["127.0.0.1"],
      });
    });

    it("returns undefined for blank, invalid, or unsupported URLs", () => {
      expect(buildRemoteBaseUrlPolicy("   ")).toBeUndefined();
      expect(buildRemoteBaseUrlPolicy("not a url")).toBeUndefined();
      expect(buildRemoteBaseUrlPolicy("file:///tmp/local.sock")).toBeUndefined();
      expect(buildRemoteBaseUrlPolicy("javascript:alert(1)")).toBeUndefined();
    });
  });

  describe("withRemoteHttpResponse", () => {
    it("delegates to SSRF-guarded fetch and releases response handle", async () => {
      const release = vi.fn(async () => {});
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: new Response("ok", { status: 200 }),
        finalUrl: "https://memory.example/v1/embed",
        release,
      });

      const result = await withRemoteHttpResponse({
        url: "https://memory.example/v1/embed",
        init: { method: "POST" },
        ssrfPolicy: { allowedHostnames: ["memory.example"] },
        onResponse: async (response) => await response.text(),
      });

      expect(result).toBe("ok");
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url: "https://memory.example/v1/embed",
        init: { method: "POST" },
        policy: { allowedHostnames: ["memory.example"] },
        auditContext: "memory-remote",
      });
      expect(release).toHaveBeenCalledTimes(1);
    });

    it("releases response handle when onResponse throws", async () => {
      const release = vi.fn(async () => {});
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: new Response("boom", { status: 500 }),
        finalUrl: "https://memory.example/v1/embed",
        release,
      });

      await expect(
        withRemoteHttpResponse({
          url: "https://memory.example/v1/embed",
          auditContext: "memory-custom",
          onResponse: async () => {
            throw new Error("parse failed");
          },
        }),
      ).rejects.toThrow("parse failed");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({ auditContext: "memory-custom" }),
      );
      expect(release).toHaveBeenCalledTimes(1);
    });
  });
});
