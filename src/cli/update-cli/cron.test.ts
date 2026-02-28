import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

// Mock modules before imports
vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../gateway-rpc.js", () => ({
  callGatewayFromCli: vi.fn(),
  addGatewayClientOptions: vi.fn((cmd) => cmd),
}));

import { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { callGatewayFromCli } from "../gateway-rpc.js";
import { registerUpdateCronCommand, UPDATE_CRON_JOB_NAME } from "./cron.js";

describe("update cron", () => {
  let parentCommand: Command;
  let mockCallGateway: Mock;
  let mockLog: Mock;
  let mockError: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    parentCommand = new Command("update");
    registerUpdateCronCommand(parentCommand);
    mockCallGateway = callGatewayFromCli as Mock;
    mockLog = defaultRuntime.log as Mock;
    mockError = defaultRuntime.error as Mock;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("constants", () => {
    it("exports the cron job name constant", () => {
      expect(UPDATE_CRON_JOB_NAME).toBe("openclaw-auto-update");
    });
  });

  describe("enable subcommand", () => {
    it("creates a cron job for automatic updates with default schedule", async () => {
      mockCallGateway.mockResolvedValue({ ok: true, job: { name: UPDATE_CRON_JOB_NAME } });

      await parentCommand.parseAsync(["node", "update", "cron", "enable"]);

      expect(mockCallGateway).toHaveBeenCalledWith(
        "cron.add",
        expect.anything(),
        expect.objectContaining({
          name: UPDATE_CRON_JOB_NAME,
          description: "Automatic OpenClaw updates",
          enabled: true,
          sessionTarget: "main",
          payload: {
            kind: "systemEvent",
            text: expect.stringContaining("openclaw update"),
          },
        }),
      );
    });

    it("uses daily schedule by default (4am)", async () => {
      mockCallGateway.mockResolvedValue({ ok: true });

      await parentCommand.parseAsync(["node", "update", "cron", "enable"]);

      expect(mockCallGateway).toHaveBeenCalledWith(
        "cron.add",
        expect.anything(),
        expect.objectContaining({
          schedule: expect.objectContaining({
            kind: "cron",
            expr: "0 4 * * *",
          }),
        }),
      );
    });

    it("accepts custom schedule via --schedule", async () => {
      mockCallGateway.mockResolvedValue({ ok: true });

      await parentCommand.parseAsync([
        "node",
        "update",
        "cron",
        "enable",
        "--schedule",
        "0 2 * * 0",
      ]);

      expect(mockCallGateway).toHaveBeenCalledWith(
        "cron.add",
        expect.anything(),
        expect.objectContaining({
          schedule: expect.objectContaining({
            kind: "cron",
            expr: "0 2 * * 0",
          }),
        }),
      );
    });

    it("accepts --channel to persist update channel", async () => {
      mockCallGateway.mockResolvedValue({ ok: true });

      await parentCommand.parseAsync(["node", "update", "cron", "enable", "--channel", "beta"]);

      expect(mockCallGateway).toHaveBeenCalledWith(
        "cron.add",
        expect.anything(),
        expect.objectContaining({
          payload: expect.objectContaining({
            text: expect.stringContaining("--channel beta"),
          }),
        }),
      );
    });

    it("accepts --every for interval-based scheduling", async () => {
      mockCallGateway.mockResolvedValue({ ok: true });

      await parentCommand.parseAsync(["node", "update", "cron", "enable", "--every", "12h"]);

      expect(mockCallGateway).toHaveBeenCalledWith(
        "cron.add",
        expect.anything(),
        expect.objectContaining({
          schedule: expect.objectContaining({
            kind: "every",
          }),
        }),
      );
    });

    it("removes existing job before creating new one", async () => {
      mockCallGateway
        .mockResolvedValueOnce({ ok: true }) // delete existing
        .mockResolvedValueOnce({ ok: true }); // add new

      await parentCommand.parseAsync(["node", "update", "cron", "enable"]);

      expect(mockCallGateway).toHaveBeenCalledWith("cron.delete", expect.anything(), {
        name: UPDATE_CRON_JOB_NAME,
      });
    });

    it("outputs success message", async () => {
      mockCallGateway.mockResolvedValue({ ok: true });

      await parentCommand.parseAsync(["node", "update", "cron", "enable"]);

      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("enabled"));
    });
  });

  describe("disable subcommand", () => {
    it("deletes the update cron job", async () => {
      mockCallGateway.mockResolvedValue({ ok: true });

      await parentCommand.parseAsync(["node", "update", "cron", "disable"]);

      expect(mockCallGateway).toHaveBeenCalledWith("cron.delete", expect.anything(), {
        name: UPDATE_CRON_JOB_NAME,
      });
    });

    it("outputs success message", async () => {
      mockCallGateway.mockResolvedValue({ ok: true });

      await parentCommand.parseAsync(["node", "update", "cron", "disable"]);

      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("disabled"));
    });

    it("handles already-disabled gracefully", async () => {
      mockCallGateway.mockRejectedValue(new Error("Job not found"));

      await parentCommand.parseAsync(["node", "update", "cron", "disable"]);

      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("not configured"));
    });
  });

  describe("status subcommand", () => {
    it("shows enabled status when job exists", async () => {
      mockCallGateway.mockResolvedValue({
        jobs: [
          {
            name: UPDATE_CRON_JOB_NAME,
            enabled: true,
            schedule: { kind: "cron", expr: "0 4 * * *" },
            nextRun: "2026-03-01T04:00:00Z",
          },
        ],
      });

      await parentCommand.parseAsync(["node", "update", "cron", "status"]);

      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Enabled"));
    });

    it("shows disabled status when job does not exist", async () => {
      mockCallGateway.mockResolvedValue({ jobs: [] });

      await parentCommand.parseAsync(["node", "update", "cron", "status"]);

      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Disabled"));
    });

    it("shows schedule in human-readable format", async () => {
      mockCallGateway.mockResolvedValue({
        jobs: [
          {
            name: UPDATE_CRON_JOB_NAME,
            enabled: true,
            schedule: { kind: "cron", expr: "0 4 * * *" },
          },
        ],
      });

      await parentCommand.parseAsync(["node", "update", "cron", "status"]);

      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("0 4 * * *"));
    });

    it("supports --json output", async () => {
      mockCallGateway.mockResolvedValue({
        jobs: [
          {
            name: UPDATE_CRON_JOB_NAME,
            enabled: true,
            schedule: { kind: "cron", expr: "0 4 * * *" },
          },
        ],
      });

      await parentCommand.parseAsync(["node", "update", "cron", "status", "--json"]);

      const logCalls = mockLog.mock.calls;
      const jsonOutput = logCalls.find((call) => {
        try {
          JSON.parse(call[0]);
          return true;
        } catch {
          return false;
        }
      });
      expect(jsonOutput).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("reports gateway errors on enable", async () => {
      mockCallGateway.mockRejectedValue(new Error("Gateway unavailable"));

      await parentCommand.parseAsync(["node", "update", "cron", "enable"]);

      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Gateway unavailable"));
    });

    it("reports gateway errors on status", async () => {
      mockCallGateway.mockRejectedValue(new Error("Gateway unavailable"));

      await parentCommand.parseAsync(["node", "update", "cron", "status"]);

      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Gateway unavailable"));
    });
  });
});
