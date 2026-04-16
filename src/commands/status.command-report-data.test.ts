import { describe, expect, it } from "vitest";
import { buildStatusCommandReportData } from "./status.command-report-data.ts";
import { createStatusCommandReportDataParams } from "./status.test-support.ts";

describe("buildStatusCommandReportData", () => {
  it("builds report inputs from shared status surfaces", async () => {
    const baseParams = createStatusCommandReportDataParams();
    const result = await buildStatusCommandReportData(
      createStatusCommandReportDataParams({
        surface: {
          ...baseParams.surface,
          gatewayProbe: { connectLatencyMs: 123, error: null },
        },
        summary: {
          ...baseParams.summary,
          a2a: {
            state: "ok",
            tasks: {
              total: 0,
              active: 0,
              failed: 0,
              waitingExternal: 0,
              delayed: 0,
              latestFailed: null,
            },
            issues: {
              brokerUnreachable: 0,
              reconcileFailed: 0,
              deliveryFailed: 0,
              cancelNotAttempted: 0,
              sessionAbortFailed: 0,
            },
            broker: {
              pluginEnabled: false,
              adapterEnabled: false,
              baseUrlPresent: false,
              edgeSecretPresent: false,
              methodScopesOk: true,
            },
          },
          sessions: {
            ...baseParams.summary.sessions,
            recent: [
              {
                ...baseParams.summary.sessions.recent[0],
                key: "session-key",
                kind: "direct",
                updatedAt: 1,
                age: 5_000,
                model: "gpt-5.4",
              },
            ],
          },
        } as never,
      }),
    );

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
