import { RequestClient } from "@buape/carbon";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadConfig } from "../config/config.js";
import { resolveDiscordAccount } from "./accounts.js";
import type { ResolvedDiscordAccount } from "./accounts.js";
import { createDiscordRestClient } from "./client.js";

// Mock dependencies
vi.mock("../config/config.js");
vi.mock("./accounts.js");

const mockLoadConfig = vi.mocked(loadConfig);
const mockResolveDiscordAccount = vi.mocked(resolveDiscordAccount);

/**
 * Helper to create a mock ResolvedDiscordAccount with sensible defaults.
 */
function mockAccount(overrides: Partial<ResolvedDiscordAccount> = {}): ResolvedDiscordAccount {
  return {
    accountId: "default",
    enabled: true,
    token: "test-token",
    tokenSource: "config",
    config: {},
    ...overrides,
  } as ResolvedDiscordAccount;
}

describe("Discord client with proxy support", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockLoadConfig.mockReturnValue({} as any);
  });

  describe("createDiscordRestClient", () => {
    it("creates a RequestClient with custom fetch when proxy is configured", () => {
      mockResolveDiscordAccount.mockReturnValue(
        mockAccount({ config: { proxy: "http://proxy.example.com:8080" } }),
      );

      const { rest } = createDiscordRestClient({});

      expect(rest).toBeInstanceOf(RequestClient);
      // Verify custom fetch is injected
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((rest as any).customFetch).toBeDefined();
    });

    it("creates a RequestClient without custom fetch when no proxy is configured", () => {
      mockResolveDiscordAccount.mockReturnValue(mockAccount({ config: {} }));

      const { rest } = createDiscordRestClient({});

      expect(rest).toBeInstanceOf(RequestClient);
      // Verify no custom fetch is injected
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((rest as any).customFetch).toBeUndefined();
    });

    it("uses existing rest client when provided (ignores proxy config)", () => {
      const existingRest = new RequestClient("existing-token");

      mockResolveDiscordAccount.mockReturnValue(
        mockAccount({ config: { proxy: "http://proxy.example.com:8080" } }),
      );

      const { rest } = createDiscordRestClient({ rest: existingRest });

      expect(rest).toBe(existingRest);
    });

    it("returns the resolved account info", () => {
      const account = mockAccount({
        accountId: "custom-account",
        config: { proxy: "http://proxy.example.com:8080" },
      });
      mockResolveDiscordAccount.mockReturnValue(account);

      const { account: returnedAccount } = createDiscordRestClient({});

      expect(returnedAccount).toBe(account);
    });

    it("returns the resolved token", () => {
      mockResolveDiscordAccount.mockReturnValue(mockAccount({ token: "my-bot-token", config: {} }));

      const { token } = createDiscordRestClient({});

      expect(token).toBe("my-bot-token");
    });

    it("uses explicit token over account token", () => {
      mockResolveDiscordAccount.mockReturnValue(
        mockAccount({ token: "account-token", config: {} }),
      );

      const { token } = createDiscordRestClient({ token: "explicit-token" });

      expect(token).toBe("explicit-token");
    });
  });

  describe("proxy URL handling", () => {
    it("trims whitespace from proxy URL", () => {
      mockResolveDiscordAccount.mockReturnValue(
        mockAccount({ config: { proxy: "  http://proxy.example.com:8080  " } }),
      );

      const { rest } = createDiscordRestClient({});

      expect(rest).toBeInstanceOf(RequestClient);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((rest as any).customFetch).toBeDefined();
    });

    it("ignores empty proxy URL", () => {
      mockResolveDiscordAccount.mockReturnValue(mockAccount({ config: { proxy: "" } }));

      const { rest } = createDiscordRestClient({});

      expect(rest).toBeInstanceOf(RequestClient);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((rest as any).customFetch).toBeUndefined();
    });

    it("ignores whitespace-only proxy URL", () => {
      mockResolveDiscordAccount.mockReturnValue(mockAccount({ config: { proxy: "   " } }));

      const { rest } = createDiscordRestClient({});

      expect(rest).toBeInstanceOf(RequestClient);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((rest as any).customFetch).toBeUndefined();
    });

    it("supports HTTP proxy URLs", () => {
      mockResolveDiscordAccount.mockReturnValue(
        mockAccount({ config: { proxy: "http://proxy.example.com:8080" } }),
      );

      const { rest } = createDiscordRestClient({});

      expect(rest).toBeInstanceOf(RequestClient);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((rest as any).customFetch).toBeDefined();
    });

    it("supports HTTPS proxy URLs", () => {
      mockResolveDiscordAccount.mockReturnValue(
        mockAccount({ config: { proxy: "https://secure-proxy.example.com:443" } }),
      );

      const { rest } = createDiscordRestClient({});

      expect(rest).toBeInstanceOf(RequestClient);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((rest as any).customFetch).toBeDefined();
    });

    it("supports authenticated proxy URLs", () => {
      mockResolveDiscordAccount.mockReturnValue(
        mockAccount({
          config: { proxy: "http://user:password@proxy.example.com:8080" },
        }),
      );

      const { rest } = createDiscordRestClient({});

      expect(rest).toBeInstanceOf(RequestClient);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((rest as any).customFetch).toBeDefined();
    });
  });
});
