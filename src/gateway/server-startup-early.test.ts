import { describe, expect, it } from "vitest";
import { createChatRunState } from "./server-chat-state.js";
import { startGatewayEarlyRuntime } from "./server-startup-early.js";

describe("startGatewayEarlyRuntime", () => {
  it("does not eagerly start the MCP loopback server", async () => {
    const chatRunState = createChatRunState();
    const earlyRuntime = await startGatewayEarlyRuntime({
      minimalTestGateway: true,
      cfgAtStart: {} as never,
      port: 18_789,
      gatewayTls: { enabled: false },
      tailscaleMode: "off" as never,
      log: {
        info: () => {},
        warn: () => {},
      },
      logDiscovery: {
        info: () => {},
        warn: () => {},
      },
      nodeRegistry: {} as never,
      broadcast: () => {},
      nodeSendToAllSubscribed: () => {},
      getPresenceVersion: () => 0,
      getHealthVersion: () => 0,
      refreshGatewayHealthSnapshot: async () => ({}) as never,
      logHealth: { error: () => {} },
      dedupe: new Map(),
      chatAbortControllers: new Map(),
      chatRunState,
      chatRunBuffers: chatRunState.buffers,
      chatDeltaSentAt: chatRunState.deltaSentAt,
      chatDeltaLastBroadcastLen: chatRunState.deltaLastBroadcastLen,
      removeChatRun: () => {},
      agentRunSeq: new Map(),
      nodeSendToSession: () => {},
      skillsRefreshDelayMs: 30_000,
      getSkillsRefreshTimer: () => null,
      setSkillsRefreshTimer: () => {},
      getRuntimeConfig: () => ({}) as never,
    });

    expect(earlyRuntime).not.toHaveProperty("mcpServer");
  });
});
