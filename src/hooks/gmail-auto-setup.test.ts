import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

// Mock external dependencies
vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../logging.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("./gmail-setup-utils.js", () => ({
  ensureTopic: vi.fn(),
  ensureSubscription: vi.fn(),
  ensureTailscaleEndpoint: vi.fn(),
  runGcloud: vi.fn(),
}));

import { runCommandWithTimeout } from "../process/exec.js";
// Import after mocks
import { runGmailAutoSetup } from "./gmail-auto-setup.js";
import { ensureTailscaleEndpoint, runGcloud } from "./gmail-setup-utils.js";

describe("gmail-auto-setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runGmailAutoSetup", () => {
    it("skips when no gmail account configured", async () => {
      const cfg: OpenClawConfig = {
        hooks: { enabled: true },
      };

      const result = await runGmailAutoSetup(cfg);

      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("no gmail account configured");
    });

    it("skips when hooks not enabled", async () => {
      const cfg: OpenClawConfig = {
        hooks: {
          enabled: false,
          gmail: { account: "test@example.com" },
        },
      };

      const result = await runGmailAutoSetup(cfg);

      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
    });

    it("returns ok when gmail configured but autoSetup not enabled", async () => {
      // No mocks needed since no service account key or tailscale auth key

      const cfg: OpenClawConfig = {
        hooks: {
          enabled: true,
          gmail: {
            account: "test@example.com",
            topic: "projects/test-project/topics/test-topic",
          },
        },
      };

      const result = await runGmailAutoSetup(cfg);

      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("autoSetup not enabled");
    });

    it("authenticates with service account when key provided", async () => {
      // Mock gcloud not authenticated initially
      vi.mocked(runCommandWithTimeout)
        .mockResolvedValueOnce({
          code: 1,
          stdout: "",
          stderr: "not authenticated",
          killed: false,
          signal: null,
          termination: "exit",
        })
        // Mock successful service account auth
        .mockResolvedValueOnce({
          code: 0,
          stdout: "Activated service account",
          stderr: "",
          killed: false,
          signal: null,
          termination: "exit",
        });

      // Mock fs for service account key
      const mockKey = JSON.stringify({
        type: "service_account",
        project_id: "test-project",
      });

      const cfg: OpenClawConfig = {
        hooks: {
          enabled: true,
          gmail: {
            account: "test@example.com",
            gcp: {
              serviceAccountKey: mockKey,
            },
          },
        },
      };

      const result = await runGmailAutoSetup(cfg);

      expect(result.ok).toBe(true);
      expect(vi.mocked(runCommandWithTimeout)).toHaveBeenCalledWith(
        expect.arrayContaining(["gcloud", "auth", "activate-service-account"]),
        expect.any(Object),
      );
    });

    it("sets up tailscale with auth key when provided", async () => {
      // Mock tailscale not connected, then tailscale up success
      // (no gcloud calls since no service account key)
      vi.mocked(runCommandWithTimeout)
        .mockResolvedValueOnce({
          code: 0,
          stdout: JSON.stringify({ BackendState: "Stopped" }),
          stderr: "",
          killed: false,
          signal: null,
          termination: "exit",
        })
        // Mock tailscale up success
        .mockResolvedValueOnce({
          code: 0,
          stdout: "",
          stderr: "",
          killed: false,
          signal: null,
          termination: "exit",
        });

      const cfg: OpenClawConfig = {
        hooks: {
          enabled: true,
          gmail: {
            account: "test@example.com",
            tailscale: {
              authKey: "tskey-test-12345",
            },
          },
        },
      };

      const result = await runGmailAutoSetup(cfg);

      expect(result.ok).toBe(true);
      expect(vi.mocked(runCommandWithTimeout)).toHaveBeenCalledWith(
        ["tailscale", "up", "--authkey", "tskey-test-12345"],
        expect.any(Object),
      );
    });

    it("skips tailscale auth when already connected", async () => {
      // Mock tailscale already connected (no gcloud calls since no service account key)
      vi.mocked(runCommandWithTimeout).mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ BackendState: "Running" }),
        stderr: "",
        killed: false,
        signal: null,
        termination: "exit",
      });

      const cfg: OpenClawConfig = {
        hooks: {
          enabled: true,
          gmail: {
            account: "test@example.com",
            tailscale: {
              authKey: "tskey-test-12345",
            },
          },
        },
      };

      const result = await runGmailAutoSetup(cfg);

      expect(result.ok).toBe(true);
      // Should only have 1 call: tailscale status (no gcloud since no service account key)
      // Should NOT have called tailscale up since already Running
      expect(vi.mocked(runCommandWithTimeout)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(runCommandWithTimeout)).toHaveBeenCalledWith(
        ["tailscale", "status", "--json"],
        expect.any(Object),
      );
    });

    it("runs full auto-setup when gcp.autoSetup is true", async () => {
      // No runCommandWithTimeout mocks needed since no service account key or tailscale auth key

      // Mock tailscale endpoint
      vi.mocked(ensureTailscaleEndpoint).mockResolvedValue(
        "https://test.ts.net/gmail-pubsub?token=abc123",
      );

      // Mock gcloud commands
      vi.mocked(runGcloud).mockResolvedValue({
        code: 0,
        stdout: "",
        stderr: "",
        killed: false,
        signal: null,
        termination: "exit",
      });

      const cfg: OpenClawConfig = {
        hooks: {
          enabled: true,
          token: "hook-token",
          gmail: {
            account: "test@example.com",
            topic: "projects/test-project/topics/test-topic",
            subscription: "test-subscription",
            pushToken: "push-token",
            gcp: {
              projectId: "test-project",
              autoSetup: true,
            },
            tailscale: {
              mode: "funnel",
              path: "/gmail-pubsub",
            },
          },
        },
      };

      const result = await runGmailAutoSetup(cfg);

      expect(result.ok).toBe(true);
      expect(result.projectId).toBe("test-project");
      expect(result.topic).toBe("projects/test-project/topics/test-topic");
      expect(result.subscription).toBe("test-subscription");
      expect(result.pushEndpoint).toContain("https://");
    });

    it("skips Pub/Sub when autoSetup enabled but no push endpoint or tailscale", async () => {
      const cfg: OpenClawConfig = {
        hooks: {
          enabled: true,
          gmail: {
            account: "test@example.com",
            gcp: {
              projectId: "test-project",
              autoSetup: true,
            },
            tailscale: {
              mode: "off",
            },
          },
        },
      };

      const result = await runGmailAutoSetup(cfg);

      expect(result.ok).toBe(true);
      expect(result.reason).toContain("no push endpoint configured");
    });

    it("fails when autoSetup enabled but no project ID", async () => {
      // No mocks needed since failure happens before external calls

      const cfg: OpenClawConfig = {
        hooks: {
          enabled: true,
          gmail: {
            account: "test@example.com",
            topic: "simple-topic-name", // No project ID in topic
            gcp: {
              autoSetup: true,
              // No projectId
            },
            tailscale: {
              mode: "funnel",
            },
          },
        },
      };

      const result = await runGmailAutoSetup(cfg);

      expect(result.ok).toBe(false);
      expect(result.error).toContain("projectId");
    });
  });
});
