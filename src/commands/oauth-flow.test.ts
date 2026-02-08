import { describe, it, expect, vi } from "vitest";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";

describe("OAuth Flow - Remote Environment", () => {
  it("should handle remote OAuth with automatic callback detection", async () => {
    const mockPrompter = {
      text: vi.fn().mockResolvedValue("not-called"),
      progress: () => ({ stop: vi.fn(), update: vi.fn() }),
    };

    const mockRuntime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const handlers = createVpsAwareOAuthHandlers({
      isRemote: true,
      prompter: mockPrompter,
      runtime: mockRuntime,
      spin: { stop: vi.fn(), update: vi.fn() } as any,
      openUrl: vi.fn(),
      localBrowserMessage: "Opening browser...",
    });

    // Simulate auth URL being generated
    await handlers.onAuth({ url: "https://oauth.provider.com/auth?state=123" });

    // Verify user gets instructions
    expect(mockRuntime.log).toHaveBeenCalled();
    const logCall = mockRuntime.log.mock.calls[0][0];
    expect(logCall).toContain("Open this URL in your LOCAL browser");
    expect(logCall).toContain("automatically detected");
  });

  it("should extract authorization code from callback URL", async () => {
    const mockPrompter = {
      text: vi.fn().mockResolvedValue("not-called"),
      progress: () => ({ stop: vi.fn(), update: vi.fn() }),
    };

    const mockRuntime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const handlers = createVpsAwareOAuthHandlers({
      isRemote: true,
      prompter: mockPrompter,
      runtime: mockRuntime,
      spin: { stop: vi.fn(), update: vi.fn() } as any,
      openUrl: vi.fn(),
      localBrowserMessage: "Opening browser...",
    });

    await handlers.onAuth({ url: "https://oauth.provider.com/auth?state=123" });

    // Simulate callback URL from user
    const callbackUrl = "http://localhost:3000/callback?code=abc123xyz";
    const code = await handlers.onPrompt({
      message: callbackUrl,
      placeholder: "authorization code",
    });

    // Should extract code from callback URL
    expect(code).toBe("abc123xyz");
  });

  it("should handle raw authorization code from user paste", async () => {
    const mockPrompter = {
      text: vi.fn().mockResolvedValue("not-called"),
      progress: () => ({ stop: vi.fn(), update: vi.fn() }),
    };

    const mockRuntime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const handlers = createVpsAwareOAuthHandlers({
      isRemote: true,
      prompter: mockPrompter,
      runtime: mockRuntime,
      spin: { stop: vi.fn(), update: vi.fn() } as any,
      openUrl: vi.fn(),
      localBrowserMessage: "Opening browser...",
    });

    await handlers.onAuth({ url: "https://oauth.provider.com/auth?state=123" });

    // Simulate raw code paste
    const code = await handlers.onPrompt({
      message: "4/0ARtbv9_abcdef123456",
      placeholder: "authorization code",
    });

    // Should accept raw code
    expect(code).toBe("4/0ARtbv9_abcdef123456");
  });

  it("should not block indefinitely in remote environment", async () => {
    const mockPrompter = {
      text: vi.fn().mockResolvedValue("manual-code-123"),
      progress: () => ({ stop: vi.fn(), update: vi.fn() }),
    };

    const mockRuntime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const handlers = createVpsAwareOAuthHandlers({
      isRemote: true,
      prompter: mockPrompter,
      runtime: mockRuntime,
      spin: { stop: vi.fn(), update: vi.fn() } as any,
      openUrl: vi.fn(),
      localBrowserMessage: "Opening browser...",
    });

    await handlers.onAuth({ url: "https://oauth.provider.com/auth?state=123" });

    // Simulate timeout: no callback received, fallback to manual prompt
    // This should eventually resolve (within timeout)
    // Wait a bit longer than the 500ms timeout in the code
    const code = await Promise.race([
      handlers.onPrompt({
        message: "paste-your-code-here",
        placeholder: "authorization code",
      }),
      new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 2000)),
    ]);

    // Should resolve with manual code, not timeout
    expect(code).not.toBe("TIMEOUT");
    expect(code).toBe("manual-code-123");
  });

  it("should handle local (non-remote) OAuth normally", async () => {
    const mockPrompter = {
      text: vi.fn(),
      progress: () => ({ stop: vi.fn(), update: vi.fn() }),
    };

    const mockRuntime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const mockOpenUrl = vi.fn().mockResolvedValue(undefined);

    const handlers = createVpsAwareOAuthHandlers({
      isRemote: false, // Local environment
      prompter: mockPrompter,
      runtime: mockRuntime,
      spin: { stop: vi.fn(), update: vi.fn() } as any,
      openUrl: mockOpenUrl,
      localBrowserMessage: "Opening browser...",
    });

    const url = "https://oauth.provider.com/auth?state=123";
    await handlers.onAuth({ url });

    // Should attempt to open URL locally
    expect(mockOpenUrl).toHaveBeenCalledWith(url);
    expect(mockRuntime.log).toHaveBeenCalledWith(`Open: ${url}`);
  });
});
