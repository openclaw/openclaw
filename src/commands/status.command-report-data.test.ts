import { describe, expect, it } from "vitest";
import { buildStatusCommandReportData } from "./status.command-report-data.ts";

describe("buildStatusCommandReportData", () => {
  it("builds report inputs from shared status surfaces", async () => {
    const result = await buildStatusCommandReportData({
      opts: { deep: true, verbose: true },
      surface: {
        cfg: { update: { channel: "stable" }, gateway: { bind: "loopback" } },
        update: {
          installKind: "git",
          git: {
            branch: "main",
            tag: "v1.2.3",
            upstream: "origin/main",
            behind: 2,
            ahead: 0,
            dirty: false,
            fetchOk: true,
          },
          registry: { latestVersion: "2026.4.9" },
        } as never,
        tailscaleMode: "serve",
        tailscaleDns: "box.tail.ts.net",
        tailscaleHttpsUrl: "https://box.tail.ts.net",
        gatewayMode: "remote",
        remoteUrlMissing: false,
        gatewayConnection: { url: "wss://gateway.example.com", urlSource: "config" },
        gatewayReachable: true,
        gatewayProbe: { connectLatencyMs: 123, error: null },
        gatewayProbeAuth: { token: "tok" },
        gatewayProbeAuthWarning: "warn-text",
        gatewaySelf: { host: "gateway", version: "1.2.3" },
        gatewayService: {
          label: "LaunchAgent",
          installed: true,
          managedByOpenClaw: true,
          loadedText: "loaded",
          runtimeShort: "running",
        },
        nodeService: {
          label: "node",
          installed: true,
          loadedText: "loaded",
          runtime: { status: "running", pid: 42 },
        },
        nodeOnlyGateway: null,
      },
      osSummary: { label: "macOS" },
      summary: {
        tasks: { total: 3, active: 1, failures: 0, byStatus: { queued: 1, running: 1 } },
        taskAudit: { errors: 1, warnings: 0 },
        heartbeat: { agents: [{ agentId: "main", enabled: true, everyMs: 60_000, every: "1m" }] },
        queuedSystemEvents: ["one", "two"],
        sessions: {
          count: 2,
          paths: ["store.json"],
          defaults: { model: "gpt-5.4", contextTokens: 12_000 },
          recent: [
            { key: "session-key", kind: "chat", updatedAt: 1, age: 5_000, model: "gpt-5.4" },
          ],
        },
      },
      securityAudit: {
        summary: { critical: 0, warn: 1, info: 0 },
        findings: [{ severity: "warn", title: "Warn first", detail: "warn detail" }],
      },
      health: { durationMs: 42 },
      usageLines: ["usage line"],
      lastHeartbeat: {
        ts: Date.now() - 30_000,
        status: "ok",
        channel: "discord",
        accountId: "acct",
      },
      agentStatus: {
        defaultId: "main",
        bootstrapPendingCount: 1,
        totalSessions: 2,
        agents: [{ id: "main", lastActiveAgeMs: 60_000 }],
      },
      channels: {
        rows: [{ id: "discord", label: "Discord", enabled: true, state: "ok", detail: "ready" }],
      },
      channelIssues: [{ channel: "discord", message: "warn msg" }],
      memory: { files: 1, chunks: 2, vector: {}, fts: {}, cache: {} },
      memoryPlugin: { enabled: true, slot: "memory" },
      pluginCompatibility: [{ pluginId: "a", severity: "warn", message: "legacy" }],
      pairingRecovery: { requestId: "req-1" },
      tableWidth: 120,
      ok: (value: string) => `ok(${value})`,
      warn: (value: string) => `warn(${value})`,
      muted: (value: string) => `muted(${value})`,
      shortenText: (value: string) => value,
      formatCliCommand: (value: string) => `cmd:${value}`,
      formatTimeAgo: (value: number) => `${value}ms`,
      formatKTokens: (value: number) => `${Math.round(value / 1000)}k`,
      formatTokensCompact: () => "12k",
      formatPromptCacheCompact: () => "cache ok",
      formatHealthChannelLines: () => ["Discord: OK · ready"],
      formatPluginCompatibilityNotice: (notice: { message?: unknown }) => String(notice.message),
      formatUpdateAvailableHint: () => "update available",
      resolveMemoryVectorState: () => ({ state: "ready", tone: "ok" }),
      resolveMemoryFtsState: () => ({ state: "ready", tone: "warn" }),
      resolveMemoryCacheSummary: () => ({ text: "cache warm", tone: "muted" }),
      accentDim: (value: string) => `accent(${value})`,
      theme: {
        heading: (value: string) => `# ${value}`,
        muted: (value: string) => `muted(${value})`,
        warn: (value: string) => `warn(${value})`,
        error: (value: string) => `error(${value})`,
      },
      renderTable: ({ rows }: { rows: Array<Record<string, string>> }) => `table:${rows.length}`,
      updateValue: "available · custom update",
    } as unknown as Parameters<typeof buildStatusCommandReportData>[0]);

    expect(result.overviewRows[0]).toEqual({
      Item: "OS",
      Value: "macOS · node " + process.versions.node,
    });
    expect(result.taskMaintenanceHint).toBe(
      "Task maintenance: cmd:openclaw tasks maintenance --apply",
    );
    expect(result.pluginCompatibilityLines).toEqual(["  warn(WARN) legacy"]);
    expect(result.pairingRecoveryLines[0]).toBe("warn(Gateway pairing approval required.)");
    expect(result.channelsRows[0]?.Channel).toBe("Discord");
    expect(result.sessionsRows[0]?.Cache).toBe("cache ok");
    expect(result.healthRows?.[0]).toEqual({
      Item: "Gateway",
      Status: "ok(reachable)",
      Detail: "42ms",
    });
    expect(result.footerLines.at(-1)).toBe("  Need to test channels? cmd:openclaw status --deep");
  });
});
