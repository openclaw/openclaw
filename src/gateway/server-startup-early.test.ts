import { describe, expect, it } from "vitest";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { DedupeEntry } from "./server-shared.js";
import { startGatewayEarlyRuntime } from "./server-startup-early.js";

type StartGatewayEarlyRuntimeParams = Parameters<typeof startGatewayEarlyRuntime>[0];

describe("startGatewayEarlyRuntime", () => {
  it("does not eagerly start the MCP loopback server", async () => {
    const earlyRuntime = await startGatewayEarlyRuntime({
      minimalTestGateway: true,
      cfgAtStart: {} as never,
      port: 18_789,
      gatewayTls: { enabled: false },
      tailscaleMode: "off" as never,
      log: {
        info: (_msg: string) => {},
        warn: (_msg: string) => {},
      },
      logDiscovery: {
        info: (_msg: string) => {},
        warn: (_msg: string) => {},
      },
      nodeRegistry: {} as never,
      broadcast: (_event: string, _payload: unknown) => {},
      nodeSendToAllSubscribed: (_event: string, _payload: unknown) => {},
      getPresenceVersion: () => 0,
      getHealthVersion: () => 0,
      refreshGatewayHealthSnapshot: async (_opts?: { probe?: boolean }) => ({}) as never,
      logHealth: { error: (_msg: string) => {} },
      dedupe: new Map<string, DedupeEntry>(),
      chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
      chatRunState: { abortedRuns: new Map<string, number>() },
      chatRunBuffers: new Map<string, string>(),
      chatDeltaSentAt: new Map<string, number>(),
      chatDeltaLastBroadcastLen: new Map<string, number>(),
      removeChatRun: () => undefined,
      agentRunSeq: new Map<string, number>(),
      nodeSendToSession: (_sessionKey: string, _event: string, _payload: unknown) => {},
      skillsRefreshDelayMs: 30_000,
      getSkillsRefreshTimer: () => null,
      setSkillsRefreshTimer: (_timer) => {},
      loadConfig: () => ({}) as never,
    } satisfies StartGatewayEarlyRuntimeParams);

    expect(earlyRuntime).not.toHaveProperty("mcpServer");
  });
});
