import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loginWithEmailPassword,
  MerlinTokenManager,
  refreshIdToken,
  resetMerlinTokenManager,
  resolveMerlinTokenManager,
} from "./merlin-auth.js";

describe("merlin-auth", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetMerlinTokenManager();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetMerlinTokenManager();
  });

  describe("loginWithEmailPassword", () => {
    it("should return tokens on successful login", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            idToken: "test-id-token",
            refreshToken: "test-refresh-token",
            expiresIn: "3600",
            localId: "test-uid",
            email: "test@example.com",
            registered: true,
          }),
      });

      const result = await loginWithEmailPassword("test@example.com", "password123");

      expect(result.idToken).toBe("test-id-token");
      expect(result.refreshToken).toBe("test-refresh-token");
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    });

    it("should throw on Firebase error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            error: {
              code: 400,
              message: "INVALID_PASSWORD",
              errors: [{ message: "INVALID_PASSWORD", domain: "global", reason: "invalid" }],
            },
          }),
      });

      await expect(loginWithEmailPassword("test@example.com", "wrong")).rejects.toThrow(
        "Merlin login failed: INVALID_PASSWORD",
      );
    });
  });

  describe("refreshIdToken", () => {
    it("should return new tokens on successful refresh", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            access_token: "new-access-token",
            expires_in: "3600",
            token_type: "Bearer",
            refresh_token: "new-refresh-token",
            id_token: "new-id-token",
            user_id: "test-uid",
            project_id: "test-project",
          }),
      });

      const result = await refreshIdToken("old-refresh-token");

      expect(result.idToken).toBe("new-id-token");
      expect(result.refreshToken).toBe("new-refresh-token");
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    });

    it("should throw on refresh failure", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            error: {
              code: 400,
              message: "TOKEN_EXPIRED",
              errors: [{ message: "TOKEN_EXPIRED", domain: "global", reason: "invalid" }],
            },
          }),
      });

      await expect(refreshIdToken("expired-token")).rejects.toThrow(
        "Merlin token refresh failed: TOKEN_EXPIRED",
      );
    });
  });

  describe("MerlinTokenManager", () => {
    it("should login on first call with email/password", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            idToken: "fresh-token",
            refreshToken: "refresh-token",
            expiresIn: "3600",
            localId: "uid",
            email: "test@example.com",
            registered: true,
          }),
      });

      const manager = new MerlinTokenManager("test@example.com", "password", undefined);
      const token = await manager.getIdToken();

      expect(token).toBe("fresh-token");
    });

    it("should return cached token on second call", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            idToken: "cached-token",
            refreshToken: "refresh-token",
            expiresIn: "3600",
            localId: "uid",
            email: "test@example.com",
            registered: true,
          }),
      });
      globalThis.fetch = fetchMock;

      const manager = new MerlinTokenManager("test@example.com", "password", undefined);
      const token1 = await manager.getIdToken();
      const token2 = await manager.getIdToken();

      expect(token1).toBe("cached-token");
      expect(token2).toBe("cached-token");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("should use refresh token when provided", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            access_token: "refreshed-token",
            expires_in: "3600",
            token_type: "Bearer",
            refresh_token: "new-refresh",
            id_token: "refreshed-token",
            user_id: "uid",
            project_id: "proj",
          }),
      });

      const manager = new MerlinTokenManager(undefined, undefined, "initial-refresh-token");
      const token = await manager.getIdToken();

      expect(token).toBe("refreshed-token");
    });

    it("should throw when no credentials available", async () => {
      const manager = new MerlinTokenManager(undefined, undefined, undefined);
      await expect(manager.getIdToken()).rejects.toThrow("Merlin authentication failed");
    });
  });

  describe("resolveMerlinTokenManager", () => {
    it("should return undefined when no env vars set", () => {
      const manager = resolveMerlinTokenManager({} as NodeJS.ProcessEnv);
      expect(manager).toBeUndefined();
    });

    it("should create manager with email and password", () => {
      const manager = resolveMerlinTokenManager({
        MERLIN_EMAIL: "test@example.com",
        MERLIN_PASSWORD: "password",
      } as unknown as NodeJS.ProcessEnv);
      expect(manager).toBeInstanceOf(MerlinTokenManager);
    });

    it("should create manager with refresh token", () => {
      const manager = resolveMerlinTokenManager({
        MERLIN_REFRESH_TOKEN: "some-refresh-token",
      } as unknown as NodeJS.ProcessEnv);
      expect(manager).toBeInstanceOf(MerlinTokenManager);
    });
  });
});
