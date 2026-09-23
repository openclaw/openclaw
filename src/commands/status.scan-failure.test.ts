import { beforeEach, describe, expect, it, vi } from "vitest";
import { statusJsonCommand } from "./status-json.js";
import { statusCommand } from "./status.command.js";

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  overview: vi.fn(),
  gateway: vi.fn(),
  node: vi.fn(),
}));
vi.mock("./node-runtime-diagnostics.js", () => ({ collectNodeRuntimeFindings: async () => [] }));
vi.mock("./status.scan.js", () => ({ scanStatus: mocks.scan }));
vi.mock("./status.scan.fast-json.js", () => ({ scanStatusJsonFast: mocks.scan }));
vi.mock("./status.scan-overview.ts", () => ({
  collectStatusScanOverview: mocks.overview,
  resolveStatusSummaryFromOverview: vi.fn(),
}));
vi.mock("./status.daemon.js", () => ({
  getDaemonStatusSummary: mocks.gateway,
  getNodeDaemonStatusSummary: mocks.node,
}));

const installationDrift =
  "Gateway service targets a different OpenClaw install: /prefix-a/lib/node_modules/openclaw (2026.9.4); active CLI: /prefix-b/lib/node_modules/openclaw (2026.9.17). Run `openclaw doctor --fix` or `openclaw gateway install --force` from the active CLI.";

describe.each([
  { mode: "text", timeoutMs: undefined },
  { mode: "fast JSON", timeoutMs: 2345 },
  { mode: "all", timeoutMs: undefined },
])("status scan failure ($mode)", ({ mode, timeoutMs }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gateway.mockReset();
  });

  async function runFailure(unavailable: boolean) {
    const original = new Error(
      "OpenClaw agent database /state/agents/main/agent.sqlite uses schema version 19; stop active agents and run openclaw doctor --fix to migrate session identities before using it.",
    );
    mocks.scan.mockRejectedValue(original);
    mocks.overview.mockRejectedValue(original);
    if (unavailable) {
      mocks.gateway.mockRejectedValue(new Error("native service inspection unavailable"));
    } else {
      mocks.gateway.mockResolvedValue({ installationDrift: `\u001b[2J${installationDrift}` });
    }
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const result =
      mode === "fast JSON"
        ? statusJsonCommand({ timeoutMs }, runtime)
        : statusCommand({ all: mode === "all", timeoutMs }, runtime);
    await expect(result).rejects.toBe(original);
    expect(mocks.gateway).toHaveBeenCalledExactlyOnceWith(timeoutMs ?? 5000);
    expect(mocks.node).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
    return runtime;
  }

  it("reports local installation drift without replacing the session schema refusal", async () => {
    const runtime = await runFailure(false);
    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(installationDrift);
  });

  it("preserves the original refusal when optional service inspection also fails", async () => {
    const runtime = await runFailure(true);
    expect(runtime.error).not.toHaveBeenCalled();
  });
});
