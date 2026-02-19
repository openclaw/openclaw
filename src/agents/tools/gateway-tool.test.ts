import { describe, expect, it, vi } from "vitest";
import { createGatewayTool } from "./gateway-tool.js";

// Mock callGatewayTool to avoid real network calls
vi.mock("./gateway.js", () => ({
  callGatewayTool: vi.fn(async () => ({ ok: true })),
  resolveGatewayOptions: vi.fn(() => ({ gatewayUrl: "ws://localhost:9999", gatewayToken: "t" })),
}));

async function executeAction(
  action: string,
  config?: { commands?: { restart?: boolean } },
  extra?: Record<string, unknown>,
): Promise<unknown> {
  const tool = createGatewayTool({ config: config as never });
  return tool.execute("call-id", { action, note: "test", ...extra });
}

describe("createGatewayTool — commands.restart guard", () => {
  describe("action: restart", () => {
    it("throws when commands.restart is false", async () => {
      await expect(executeAction("restart", { commands: { restart: false } })).rejects.toThrow(
        "Gateway restart is disabled",
      );
    });

    it("throws when commands.restart is unset", async () => {
      await expect(executeAction("restart", {})).rejects.toThrow("Gateway restart is disabled");
    });

    it("proceeds when commands.restart is true", async () => {
      await expect(
        executeAction("restart", { commands: { restart: true } }),
      ).resolves.toBeDefined();
    });
  });

  describe("action: config.apply", () => {
    it("throws when commands.restart is false", async () => {
      await expect(
        executeAction("config.apply", { commands: { restart: false } }, { raw: "{}" }),
      ).rejects.toThrow("Gateway restart is disabled");
    });

    it("throws when commands.restart is unset", async () => {
      await expect(executeAction("config.apply", {}, { raw: "{}" })).rejects.toThrow(
        "Gateway restart is disabled",
      );
    });

    it("includes side-effect explanation in error message", async () => {
      await expect(
        executeAction("config.apply", { commands: { restart: false } }, { raw: "{}" }),
      ).rejects.toThrow("config.apply triggers a restart");
    });
  });

  describe("action: config.patch", () => {
    it("throws when commands.restart is false", async () => {
      await expect(executeAction("config.patch", { commands: { restart: false } })).rejects.toThrow(
        "Gateway restart is disabled",
      );
    });

    it("throws when commands.restart is unset", async () => {
      await expect(executeAction("config.patch", {})).rejects.toThrow(
        "Gateway restart is disabled",
      );
    });

    it("includes side-effect explanation in error message", async () => {
      await expect(executeAction("config.patch", { commands: { restart: false } })).rejects.toThrow(
        "config.patch triggers a restart",
      );
    });
  });
});
