// Status-all report-lines tests verify rendered report structure and diagnosis section integration.
import { describe, expect, it, vi } from "vitest";
import type { ProgressReporter } from "../../cli/progress.js";
import { truncateUtf16Safe } from "../../utils.js";
import { buildStatusAllReportLines } from "./report-lines.js";

const diagnosisSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./diagnosis.js", () => ({
  appendStatusAllDiagnosis: diagnosisSpy,
}));

describe("buildStatusAllReportLines", () => {
  it("renders bootstrap column using file-presence semantics", async () => {
    const progress: ProgressReporter = {
      setLabel: () => {},
      setPercent: () => {},
      tick: () => {},
      done: () => {},
    };
    const lines = await buildStatusAllReportLines({
      progress,
      overviewRows: [{ Item: "Gateway", Value: "ok" }],
      channels: {
        rows: [],
        details: [],
      },
      channelIssues: [],
      agentStatus: {
        agents: [
          {
            id: "main",
            bootstrapPending: true,
            sessionsCount: 1,
            lastActiveAgeMs: 12_000,
            sessionsPath: "/tmp/main-sessions.json",
          },
          {
            id: "ops",
            bootstrapPending: false,
            sessionsCount: 0,
            lastActiveAgeMs: null,
            sessionsPath: "/tmp/ops-sessions.json",
          },
        ],
      },
      connectionDetailsForReport: "",
      diagnosis: {
        snap: null,
        remoteUrlMissing: false,
        secretDiagnostics: [],
        sentinel: null,
        lastErr: null,
        port: 18789,
        portUsage: null,
        tailscaleMode: "off",
        tailscale: {
          backendState: null,
          dnsName: null,
          ips: [],
          error: null,
        },
        tailscaleHttpsUrl: null,
        skillStatus: null,
        pluginCompatibility: [],
        channelsStatus: null,
        channelIssues: [],
        deliveryDiagnostics: null,
        gatewayReachable: false,
        health: null,
        nodeOnlyGateway: null,
      },
    });

    const output = lines.join("\n");
    expect(output).toContain("Bootstrap file");
    expect(output).toContain("PRESENT");
    expect(output).toContain("ABSENT");
    expect(diagnosisSpy).toHaveBeenCalledOnce();
    const [diagnosisOptions] = diagnosisSpy.mock.calls[0] as unknown as [
      { secretDiagnostics?: unknown[] },
    ];
    expect(diagnosisOptions?.secretDiagnostics).toEqual([]);
  });

  it("does not cut issue messages with an emoji straddling the truncation boundary", () => {
    // "🚀" is a surrogate pair (2 UTF-16 code units). An issue title with 89
    // 'x' + the emoji spans the 90-character boundary. truncateUtf16Safe
    // detects the incomplete pair and backs out to the previous whole character,
    // while raw slice would split the pair and produce a lone high surrogate.
    const title = "x".repeat(89) + "🚀";
    // Raw slice would cut at position 90, splitting the surrogate pair:
    const sliced = title.slice(0, 90);
    expect(sliced.charCodeAt(89)).toBe(0xd83d); // lone high surrogate
    // truncateUtf16Safe drops the incomplete pair:
    expect(truncateUtf16Safe(title, 90)).toBe("x".repeat(89));
  });

  it("preserves issue messages shorter than the limit byte-for-byte", () => {
    expect(truncateUtf16Safe("short message", 90)).toBe("short message");
    expect(truncateUtf16Safe("", 90)).toBe("");
  });
});
