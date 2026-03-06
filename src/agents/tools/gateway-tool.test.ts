import { describe, expect, it } from "vitest";
import { createGatewayTool } from "./gateway-tool.js";

describe("createGatewayTool", () => {
  it("rejects gateway restart from a cron session key", async () => {
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:cron:daily-report",
    });
    await expect(tool.execute("call-1", { action: "restart" })).rejects.toThrow(
      /not allowed from a cron job session/,
    );
  });

  it("rejects gateway restart from a cron run session key", async () => {
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:cron:job-1:run:abc123",
    });
    await expect(tool.execute("call-1", { action: "restart" })).rejects.toThrow(
      /not allowed from a cron job session/,
    );
  });

  it("does not block restart for non-cron session keys", async () => {
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: { commands: { restart: false } } as never,
    });
    await expect(tool.execute("call-1", { action: "restart" })).rejects.toThrow(
      /restart is disabled/,
    );
  });
});
