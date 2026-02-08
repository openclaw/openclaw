import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted(() => ({
  getPageForTargetId: vi.fn(),
  ensurePageState: vi.fn(),
}));

vi.mock("./pw-session.js", () => sessionMocks);

async function importModule() {
  return await import("./pw-tools-core.snapshot.js");
}

describe("VULN-013: browser navigation SSRF protection", () => {
  let mockPage: {
    goto: ReturnType<typeof vi.fn>;
    url: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockPage = {
      goto: vi.fn(async () => {}),
      url: vi.fn(() => "https://example.com"),
    };
    sessionMocks.getPageForTargetId.mockResolvedValue(mockPage);
    sessionMocks.ensurePageState.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.resetModules();
    for (const fn of Object.values(sessionMocks)) {
      fn.mockReset();
    }
  });

  describe("protocol blocking", () => {
    it("blocks file:// protocol", async () => {
      const { navigateViaPlaywright } = await importModule();
      await expect(
        navigateViaPlaywright({ cdpUrl: "ws://localhost:9222", url: "file:///etc/passwd" }),
      ).rejects.toThrow(/protocol not allowed/i);
      expect(mockPage.goto).not.toHaveBeenCalled();
    });

    it("blocks javascript: protocol", async () => {
      const { navigateViaPlaywright } = await importModule();
      await expect(
        navigateViaPlaywright({ cdpUrl: "ws://localhost:9222", url: "javascript:alert(1)" }),
      ).rejects.toThrow(/protocol not allowed/i);
      expect(mockPage.goto).not.toHaveBeenCalled();
    });

    it("blocks data: protocol", async () => {
      const { navigateViaPlaywright } = await importModule();
      await expect(
        navigateViaPlaywright({ cdpUrl: "ws://localhost:9222", url: "data:text/html,<h1>hi</h1>" }),
      ).rejects.toThrow(/protocol not allowed/i);
      expect(mockPage.goto).not.toHaveBeenCalled();
    });
  });

  describe("hostname blocking", () => {
    it("blocks localhost", async () => {
      const { navigateViaPlaywright } = await importModule();
      await expect(
        navigateViaPlaywright({ cdpUrl: "ws://localhost:9222", url: "http://localhost/admin" }),
      ).rejects.toThrow(/blocked hostname/i);
      expect(mockPage.goto).not.toHaveBeenCalled();
    });

    it("blocks .local domains", async () => {
      const { navigateViaPlaywright } = await importModule();
      await expect(
        navigateViaPlaywright({ cdpUrl: "ws://localhost:9222", url: "http://printer.local/" }),
      ).rejects.toThrow(/blocked hostname/i);
      expect(mockPage.goto).not.toHaveBeenCalled();
    });

    it("blocks .internal domains", async () => {
      const { navigateViaPlaywright } = await importModule();
      await expect(
        navigateViaPlaywright({
          cdpUrl: "ws://localhost:9222",
          url: "http://metadata.google.internal/computeMetadata/v1/",
        }),
      ).rejects.toThrow(/blocked hostname/i);
      expect(mockPage.goto).not.toHaveBeenCalled();
    });
  });

  describe("private IP blocking", () => {
    it("blocks 127.0.0.1 (loopback)", async () => {
      const { navigateViaPlaywright } = await importModule();
      await expect(
        navigateViaPlaywright({ cdpUrl: "ws://localhost:9222", url: "http://127.0.0.1/" }),
      ).rejects.toThrow(/private|internal/i);
      expect(mockPage.goto).not.toHaveBeenCalled();
    });

    it("blocks 169.254.169.254 (cloud metadata)", async () => {
      const { navigateViaPlaywright } = await importModule();
      await expect(
        navigateViaPlaywright({
          cdpUrl: "ws://localhost:9222",
          url: "http://169.254.169.254/latest/meta-data/",
        }),
      ).rejects.toThrow(/private|internal/i);
      expect(mockPage.goto).not.toHaveBeenCalled();
    });

    it("blocks 10.0.0.1 (RFC1918)", async () => {
      const { navigateViaPlaywright } = await importModule();
      await expect(
        navigateViaPlaywright({ cdpUrl: "ws://localhost:9222", url: "http://10.0.0.1/" }),
      ).rejects.toThrow(/private|internal/i);
      expect(mockPage.goto).not.toHaveBeenCalled();
    });

    it("blocks 192.168.1.1 (RFC1918)", async () => {
      const { navigateViaPlaywright } = await importModule();
      await expect(
        navigateViaPlaywright({ cdpUrl: "ws://localhost:9222", url: "http://192.168.1.1/" }),
      ).rejects.toThrow(/private|internal/i);
      expect(mockPage.goto).not.toHaveBeenCalled();
    });

    it("blocks 172.16.0.1 (RFC1918)", async () => {
      const { navigateViaPlaywright } = await importModule();
      await expect(
        navigateViaPlaywright({ cdpUrl: "ws://localhost:9222", url: "http://172.16.0.1/" }),
      ).rejects.toThrow(/private|internal/i);
      expect(mockPage.goto).not.toHaveBeenCalled();
    });

    it("blocks ::1 (IPv6 loopback)", async () => {
      const { navigateViaPlaywright } = await importModule();
      await expect(
        navigateViaPlaywright({ cdpUrl: "ws://localhost:9222", url: "http://[::1]/" }),
      ).rejects.toThrow(/private|internal/i);
      expect(mockPage.goto).not.toHaveBeenCalled();
    });

    it("blocks IPv6-mapped IPv4 loopback", async () => {
      const { navigateViaPlaywright } = await importModule();
      await expect(
        navigateViaPlaywright({ cdpUrl: "ws://localhost:9222", url: "http://[::ffff:127.0.0.1]/" }),
      ).rejects.toThrow(/private|internal/i);
      expect(mockPage.goto).not.toHaveBeenCalled();
    });
  });

  describe("valid URLs", () => {
    it("allows https://example.com", async () => {
      const { navigateViaPlaywright } = await importModule();
      const result = await navigateViaPlaywright({
        cdpUrl: "ws://localhost:9222",
        url: "https://example.com",
      });
      expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", expect.any(Object));
      expect(result.url).toBe("https://example.com");
    });

    it("allows http://93.184.216.34 (public IP)", async () => {
      const { navigateViaPlaywright } = await importModule();
      await navigateViaPlaywright({
        cdpUrl: "ws://localhost:9222",
        url: "http://93.184.216.34/",
      });
      expect(mockPage.goto).toHaveBeenCalledWith("http://93.184.216.34/", expect.any(Object));
    });
  });

  describe("error handling", () => {
    it("rejects invalid URLs", async () => {
      const { navigateViaPlaywright } = await importModule();
      await expect(
        navigateViaPlaywright({ cdpUrl: "ws://localhost:9222", url: "not-a-valid-url" }),
      ).rejects.toThrow(/invalid url/i);
      expect(mockPage.goto).not.toHaveBeenCalled();
    });
  });
});
