import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { checkCircuitBreaker, fetchURL } from "./fuse.js";

// Mock the update-runner and restart modules
vi.mock("../../infra/update-runner.js", () => ({
  runGatewayUpdate: vi.fn(),
}));

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: vi.fn(),
}));

vi.mock("../../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn().mockResolvedValue("/fake/root"),
}));

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { runGatewayUpdate } from "../../infra/update-runner.js";
import { runCommandWithTimeout } from "../../process/exec.js";

describe("fuse circuit breaker", () => {
  const mockGateway = {
    log: vi.fn(),
  };

  beforeEach(() => {
    vi.resetAllMocks();

    // Mock fetch to handle file:// URLs
    global.fetch = vi.fn(async (url: string | URL) => {
      const urlString = typeof url === "string" ? url : url.toString();

      if (urlString.startsWith("file://")) {
        // Handle file:// URLs by reading from filesystem
        return await fetchURL(url);
      }

      // For non-file URLs, return a mock response
      return {
        ok: true,
        text: async () => "",
      } as Response;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper to write FUSE.txt content and run a test with it.
   * Creates an isolated temp directory for each invocation.
   * Automatically cleans up after the test completes.
   */
  async function withFuseFile(
    content: string,
    test: (config: OpenClawConfig) => Promise<void>,
  ): Promise<void> {
    const testDir = mkdtempSync(join(tmpdir(), "fuse-test-"));
    const testPath = join(testDir, "FUSE.txt");

    try {
      writeFileSync(testPath, content, "utf-8");
      const config: OpenClawConfig = {
        update: {
          fuseUrl: `file://${testPath}`,
        },
      };
      await test(config);
    } finally {
      // Clean up temp directory
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  it("should allow processing when fetch fails", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));

    const config: OpenClawConfig = {};
    const result = await checkCircuitBreaker(config, mockGateway);

    expect(result).toBe(true);
    expect(mockGateway.log).not.toHaveBeenCalled();
  });

  it("should allow processing when FUSE is empty", async () => {
    await withFuseFile("", async (config) => {
      const result = await checkCircuitBreaker(config, mockGateway);

      expect(result).toBe(true);
      expect(mockGateway.log).not.toHaveBeenCalled();
    });
  });

  it("should allow processing when FUSE is empty (original fetch mock test)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "",
    });

    const config: OpenClawConfig = {};
    const result = await checkCircuitBreaker(config, mockGateway);

    expect(result).toBe(true);
    expect(mockGateway.log).not.toHaveBeenCalled();
  });

  it("should suspend processing on HOLD command", async () => {
    await withFuseFile("HOLD for maintenance", async (config) => {
      const result = await checkCircuitBreaker(config, mockGateway);

      expect(result).toBe(false);
      expect(mockGateway.log).toHaveBeenCalledWith("Processing suspended for maintenance");
    });
  });

  it("should allow processing on HOLD when missionCritical is true", async () => {
    await withFuseFile("HOLD for maintenance", async (config) => {
      config.update!.missionCritical = true;

      const result = await checkCircuitBreaker(config, mockGateway);

      expect(result).toBe(true);
      expect(mockGateway.log).toHaveBeenCalledWith(
        "Processing suspended centrally but you have opted out; processing continues.",
      );
    });
  });

  it("should handle HOLD with minimal reason", async () => {
    await withFuseFile("HOLD", async (config) => {
      const result = await checkCircuitBreaker(config, mockGateway);

      expect(result).toBe(false);
      expect(mockGateway.log).toHaveBeenCalledWith("Processing suspended.");
    });
  });

  it("should log UPGRADE message when manualUpgrade is true", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "UPGRADE v2.0.0",
    });

    const config: OpenClawConfig = {
      update: {
        manualUpgrade: true,
      },
    };
    const result = await checkCircuitBreaker(config, mockGateway);

    expect(result).toBe(true);
    expect(mockGateway.log).toHaveBeenCalledWith(
      "Upgrade v2.0.0 available. Type openclaw upgrade v2.0.0 into terminal.",
    );
    expect(runGatewayUpdate).not.toHaveBeenCalled();
  });

  it("should trigger auto-upgrade when manualUpgrade is false", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "UPGRADE v2.0.0",
    });

    // Ensure package root resolves successfully
    (resolveOpenClawPackageRoot as ReturnType<typeof vi.fn>).mockResolvedValue("/fake/root");

    // Mock git tag check - tag doesn't exist so upgrade proceeds
    (runCommandWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
    });

    (runGatewayUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      mode: "git",
      root: "/fake/root",
      after: { version: "v2.0.0" },
      steps: [],
      durationMs: 1000,
    });

    const config: OpenClawConfig = {
      update: {
        manualUpgrade: false,
      },
    };
    const result = await checkCircuitBreaker(config, mockGateway);

    expect(result).toBe(true);

    // Wait for async upgrade to start
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(runGatewayUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: "v2.0.0",
        timeoutMs: 10 * 60 * 1000,
      }),
    );
  });

  it("should schedule restart after successful upgrade", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "UPGRADE v2.0.0",
    });

    // Ensure package root resolves successfully
    (resolveOpenClawPackageRoot as ReturnType<typeof vi.fn>).mockResolvedValue("/fake/root");

    // Mock git tag check - tag doesn't exist so upgrade proceeds
    (runCommandWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
    });

    (runGatewayUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      mode: "git",
      root: "/fake/root",
      after: { version: "v2.0.0" },
      steps: [],
      durationMs: 1000,
    });

    const config: OpenClawConfig = {
      update: {
        manualUpgrade: false,
      },
    };

    await checkCircuitBreaker(config, mockGateway);

    // Wait for async upgrade to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledWith({
      delayMs: 2000,
      reason: "upgrade to v2.0.0",
    });
  });

  it("should log ANNOUNCE message", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "ANNOUNCE New features available in latest release",
    });

    const config: OpenClawConfig = {};
    const result = await checkCircuitBreaker(config, mockGateway);

    expect(result).toBe(true);
    expect(mockGateway.log).toHaveBeenCalledWith("New features available in latest release");
  });

  it("should allow processing for unknown commands", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "UNKNOWN command",
    });

    const config: OpenClawConfig = {};
    const result = await checkCircuitBreaker(config, mockGateway);

    expect(result).toBe(true);
    expect(mockGateway.log).not.toHaveBeenCalled();
  });

  it("should include User-Agent header in fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
    });
    global.fetch = mockFetch;

    const config: OpenClawConfig = {};
    await checkCircuitBreaker(config, mockGateway);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/openclaw/openclaw/refs/heads/main/FUSE.txt",
      expect.objectContaining({
        headers: {
          "User-Agent": "openclaw-gateway",
        },
      }),
    );
  });

  it("should reject UPGRADE command with no version", async () => {
    await withFuseFile("UPGRADE ", async (config) => {
      const result = await checkCircuitBreaker(config, mockGateway);

      expect(result).toBe(true); // Cron continues
      // After trimming "UPGRADE " becomes "UPGRADE", so we get the format error
      expect(mockGateway.log).toHaveBeenCalledWith(
        "Invalid UPGRADE command: expected format 'UPGRADE version'",
      );
      expect(runGatewayUpdate).not.toHaveBeenCalled();
    });
  });

  it("should reject UPGRADE command with only whitespace version", async () => {
    await withFuseFile("UPGRADE   ", async (config) => {
      // Multiple spaces
      const result = await checkCircuitBreaker(config, mockGateway);

      expect(result).toBe(true); // Cron continues
      // After trimming "UPGRADE   " becomes "UPGRADE"
      expect(mockGateway.log).toHaveBeenCalledWith(
        "Invalid UPGRADE command: expected format 'UPGRADE version'",
      );
      expect(runGatewayUpdate).not.toHaveBeenCalled();
    });
  });

  it("should reject UPGRADE command without space", async () => {
    await withFuseFile("UPGRADE", async (config) => {
      const result = await checkCircuitBreaker(config, mockGateway);

      expect(result).toBe(true); // Cron continues
      expect(mockGateway.log).toHaveBeenCalledWith(
        "Invalid UPGRADE command: expected format 'UPGRADE version'",
      );
      expect(runGatewayUpdate).not.toHaveBeenCalled();
    });
  });

  it("should reject ANNOUNCE command with no message", async () => {
    await withFuseFile("ANNOUNCE ", async (config) => {
      const result = await checkCircuitBreaker(config, mockGateway);

      expect(result).toBe(true); // Cron continues
      // After trimming "ANNOUNCE " becomes "ANNOUNCE", so we get the format error
      expect(mockGateway.log).toHaveBeenCalledWith(
        "Invalid ANNOUNCE command: expected format 'ANNOUNCE message'",
      );
    });
  });

  it("should reject ANNOUNCE command without space", async () => {
    await withFuseFile("ANNOUNCE", async (config) => {
      const result = await checkCircuitBreaker(config, mockGateway);

      expect(result).toBe(true); // Cron continues
      expect(mockGateway.log).toHaveBeenCalledWith(
        "Invalid ANNOUNCE command: expected format 'ANNOUNCE message'",
      );
    });
  });

  it("should use custom FUSE URL when configured", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "ANNOUNCE Custom FUSE source",
    });
    global.fetch = mockFetch;

    const config: OpenClawConfig = {
      update: {
        fuseUrl: "https://example.com/custom-fuse.txt",
      },
    };
    const result = await checkCircuitBreaker(config, mockGateway);

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/custom-fuse.txt",
      expect.objectContaining({
        headers: {
          "User-Agent": "openclaw-gateway",
        },
      }),
    );
    expect(mockGateway.log).toHaveBeenCalledWith("Custom FUSE source");
  });

  it("should log upgrade progress steps", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "UPGRADE v2.0.0",
    });

    // Ensure package root resolves successfully
    (resolveOpenClawPackageRoot as ReturnType<typeof vi.fn>).mockResolvedValue("/fake/root");

    // Mock git tag check - tag doesn't exist so upgrade proceeds
    (runCommandWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
    });

    (runGatewayUpdate as ReturnType<typeof vi.fn>).mockImplementation(async (opts) => {
      // Simulate progress callbacks
      opts.progress?.onStepStart?.({ name: "git fetch", command: "git fetch", index: 0, total: 3 });
      opts.progress?.onStepComplete?.({
        name: "git fetch",
        command: "git fetch",
        index: 0,
        total: 3,
        durationMs: 100,
        exitCode: 0,
      });

      return {
        status: "ok",
        mode: "git",
        root: "/fake/root",
        after: { version: "v2.0.0" },
        steps: [],
        durationMs: 1000,
      };
    });

    const config: OpenClawConfig = {
      update: {
        manualUpgrade: false,
      },
    };

    await checkCircuitBreaker(config, mockGateway);

    // Wait for async upgrade to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockGateway.log).toHaveBeenCalledWith(
      expect.stringContaining("Starting upgrade to v2.0.0"),
    );
    expect(mockGateway.log).toHaveBeenCalledWith("[1/3] git fetch...");
    expect(mockGateway.log).toHaveBeenCalledWith(
      expect.stringContaining("Upgrade to v2.0.0 completed successfully"),
    );
  });

  it("should only process the first line of FUSE content", async () => {
    await withFuseFile(
      "HOLD for maintenance\nUPGRADE v2.0.0\nANNOUNCE other stuff",
      async (config) => {
        const result = await checkCircuitBreaker(config, mockGateway);

        // Should process HOLD from first line only, ignoring UPGRADE and ANNOUNCE on later lines
        expect(result).toBe(false);
        expect(mockGateway.log).toHaveBeenCalledWith("Processing suspended for maintenance");
      },
    );
  });

  it("should handle first line with comments on subsequent lines", async () => {
    await withFuseFile(
      "ANNOUNCE System maintenance tonight\n# Comment line\n# Another comment",
      async (config) => {
        const result = await checkCircuitBreaker(config, mockGateway);

        expect(result).toBe(true);
        expect(mockGateway.log).toHaveBeenCalledWith("System maintenance tonight");
        // Should not process comment lines
        expect(mockGateway.log).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("should handle upgrade failures gracefully", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "UPGRADE v2.0.0",
    });

    // Ensure package root resolves successfully
    (resolveOpenClawPackageRoot as ReturnType<typeof vi.fn>).mockResolvedValue("/fake/root");

    // Mock git tag check - tag doesn't exist so upgrade proceeds
    (runCommandWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
    });

    (runGatewayUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "error",
      mode: "git",
      root: "/fake/root",
      reason: "git-fetch-failed",
      steps: [
        {
          name: "git fetch",
          command: "git fetch",
          cwd: "/fake/root",
          durationMs: 100,
          exitCode: 1,
          stderrTail: "Connection refused",
        },
      ],
      durationMs: 1000,
    });

    const config: OpenClawConfig = {
      update: {
        manualUpgrade: false,
      },
    };

    const result = await checkCircuitBreaker(config, mockGateway);

    expect(result).toBe(true); // Cron should still continue

    // Wait for async upgrade to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockGateway.log).toHaveBeenCalledWith(expect.stringContaining("Upgrade failed"));
    expect(scheduleGatewaySigusr1Restart).not.toHaveBeenCalled();
  });

  it("should skip upgrade when tag already exists locally", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "UPGRADE v2.0.0",
    });

    // Ensure package root resolves successfully
    (resolveOpenClawPackageRoot as ReturnType<typeof vi.fn>).mockResolvedValue("/fake/root");

    // Mock git tag check - tag exists locally (downgrade protection)
    (runCommandWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "v2.0.0\n",
      stderr: "",
      code: 0,
    });

    const config: OpenClawConfig = {
      update: {
        manualUpgrade: false,
      },
    };

    const result = await checkCircuitBreaker(config, mockGateway);

    expect(result).toBe(true); // Cron should still continue

    // Wait for async upgrade to start
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should be skipped due to tag already existing
    expect(mockGateway.log).toHaveBeenCalledWith(
      "Upgrade skipped: tag v2.0.0 already exists locally (forward upgrades only)",
    );
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1Restart).not.toHaveBeenCalled();
  });

  it("should force upgrade when version ends with !", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "UPGRADE v2.0.0!",
    });

    // Ensure package root resolves successfully
    (resolveOpenClawPackageRoot as ReturnType<typeof vi.fn>).mockResolvedValue("/fake/root");

    // Mock git tag check - tag exists locally but should be ignored due to force flag
    (runCommandWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "v2.0.0\n",
      stderr: "",
      code: 0,
    });

    (runGatewayUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      mode: "git",
      root: "/fake/root",
      after: { version: "v2.0.0" },
      steps: [],
      durationMs: 1000,
    });

    const config: OpenClawConfig = {
      update: {
        manualUpgrade: false,
      },
    };

    const result = await checkCircuitBreaker(config, mockGateway);

    expect(result).toBe(true);

    // Wait for async upgrade to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should log force upgrade message
    expect(mockGateway.log).toHaveBeenCalledWith(
      "Force upgrade requested (version ends with '!'), skipping downgrade protection",
    );

    // Should proceed with upgrade despite tag existing
    expect(runGatewayUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: "v2.0.0", // Should strip the '!' from the tag
        timeoutMs: 10 * 60 * 1000,
      }),
    );

    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledWith({
      delayMs: 2000,
      reason: "upgrade to v2.0.0",
    });
  });

  it("should handle force upgrade with manual mode", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "UPGRADE v1.9.0!",
    });

    const config: OpenClawConfig = {
      update: {
        manualUpgrade: true,
      },
    };

    const result = await checkCircuitBreaker(config, mockGateway);

    expect(result).toBe(true);

    // Manual mode should show notification with the ! included
    expect(mockGateway.log).toHaveBeenCalledWith(
      "Upgrade v1.9.0! available. Type openclaw upgrade v1.9.0! into terminal.",
    );

    // Should not trigger auto-upgrade
    expect(runGatewayUpdate).not.toHaveBeenCalled();
  });

  it("should skip FUSE polling when both missionCritical and manualUpgrade are true", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    const config: OpenClawConfig = {
      update: {
        missionCritical: true,
        manualUpgrade: true,
      },
    };
    const result = await checkCircuitBreaker(config, mockGateway);

    expect(result).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled(); // Key assertion - no network call
    expect(mockGateway.log).not.toHaveBeenCalled();
  });

  it("should still fetch FUSE when only missionCritical is true", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "ANNOUNCE Test message",
    });
    global.fetch = mockFetch;

    const config: OpenClawConfig = {
      update: {
        missionCritical: true,
        manualUpgrade: false,
      },
    };
    const result = await checkCircuitBreaker(config, mockGateway);

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalled(); // Should still fetch
    expect(mockGateway.log).toHaveBeenCalledWith("Test message");
  });

  it("should still fetch FUSE when only manualUpgrade is true", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "ANNOUNCE Test message",
    });
    global.fetch = mockFetch;

    const config: OpenClawConfig = {
      update: {
        missionCritical: false,
        manualUpgrade: true,
      },
    };
    const result = await checkCircuitBreaker(config, mockGateway);

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalled(); // Should still fetch
    expect(mockGateway.log).toHaveBeenCalledWith("Test message");
  });

  it("should handle concurrent upgrade requests with lock", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "UPGRADE v2.0.0",
    });

    (resolveOpenClawPackageRoot as ReturnType<typeof vi.fn>).mockResolvedValue("/fake/root");
    (runCommandWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
    });

    // Mock a slow upgrade
    (runGatewayUpdate as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              status: "ok",
              mode: "git",
              root: "/fake/root",
              after: { version: "v2.0.0" },
              steps: [],
              durationMs: 1000,
            });
          }, 100);
        }),
    );

    const config: OpenClawConfig = {
      update: {
        manualUpgrade: false,
      },
    };

    // Trigger two upgrades in quick succession
    const result1Promise = checkCircuitBreaker(config, mockGateway);
    const result2Promise = checkCircuitBreaker(config, mockGateway);

    await Promise.all([result1Promise, result2Promise]);

    // Wait for async upgrades to complete
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Only one upgrade should have been executed (the second should be skipped due to lock)
    expect(runGatewayUpdate).toHaveBeenCalledTimes(1);
    expect(mockGateway.log).toHaveBeenCalledWith(
      "Upgrade already in progress, skipping duplicate request",
    );
  });
});
