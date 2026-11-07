import { beforeEach, expect, it, vi } from "vitest";
import { renderSessionsUsage, sessionsUsageCommand } from "./sessions-usage.js";

const mocks = vi.hoisted(() => ({ callGateway: vi.fn() }));

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/gateway-rpc.js")>()),
  callGatewayFromCliWithTransport: mocks.callGateway,
}));

function runtime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeStdout: vi.fn(), writeJson: vi.fn() };
}

function printed(out: ReturnType<typeof runtime>): string {
  return out.log.mock.calls.map(([line]) => String(line)).join("\n");
}

const totals = () => ({
  input: 1000,
  output: 500,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1500,
  totalCost: 0.0042,
  inputCost: 0.001,
  outputCost: 0.002,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
});

const aggregates = () => ({
  sessionCount: 1,
  messages: { total: 12, user: 6, assistant: 6, toolCalls: 2, toolResults: 2, errors: 0 },
  tools: { totalCalls: 2, uniqueTools: 1, tools: [{ name: "read", count: 2 }] },
  byModel: [],
  byProvider: [],
  byAgent: [],
  byChannel: [],
  daily: [],
});

const row = () => ({
  key: "agent:main:main",
  label: "Main",
  agentId: "main",
  model: "gpt-6-astra",
  usage: {
    ...totals(),
    messageCounts: { total: 12, user: 6, assistant: 6, toolCalls: 2, toolResults: 2, errors: 0 },
  },
});

const result = () => ({
  updatedAt: 1,
  startDate: "2026-10-01",
  endDate: "2026-10-31",
  sessions: [row()],
  totals: totals(),
  aggregates: aggregates(),
});

beforeEach(() => vi.clearAllMocks());

it("forwards the default list query and renders rows with totals", async () => {
  mocks.callGateway.mockResolvedValue(result());
  const out = runtime();

  await sessionsUsageCommand({}, out);

  expect(mocks.callGateway).toHaveBeenCalledWith(
    "sessions.usage",
    expect.objectContaining({ json: undefined }),
    {},
    expect.objectContaining({ defaultTimeoutMs: 30_000 }),
  );
  const text = printed(out);
  expect(text).toContain("Main");
  expect(text).toContain("1.5k");
  expect(text).toContain("Totals:");
  expect(out.exit).not.toHaveBeenCalled();
});

it("rejects conflicting scope and range selectors before dispatch", async () => {
  const reads = runtime();
  await expect(sessionsUsageCommand({ agent: "work", all: true }, reads)).rejects.toThrow(
    "Use --agent or --all, not both",
  );
  await expect(
    sessionsUsageCommand({ sessionKey: "agent:main:main", all: true }, reads),
  ).rejects.toThrow("A session key cannot be combined with --all.");
  await expect(
    sessionsUsageCommand({ range: "30d", startDate: "2026-10-01" }, reads),
  ).rejects.toThrow("Use --range or explicit --start/--end, not both");
  await expect(sessionsUsageCommand({ endDate: "2026-10-31" }, reads)).rejects.toThrow(
    "--end requires --start.",
  );
  await expect(sessionsUsageCommand({ range: "2w" }, reads)).rejects.toThrow(
    "--range must be one of 7d, 30d, 90d, 1y, all.",
  );
  await expect(sessionsUsageCommand({ startDate: "10-01" }, reads)).rejects.toThrow(
    "--start must be a YYYY-MM-DD date.",
  );
  expect(mocks.callGateway).not.toHaveBeenCalled();
});

it("exits nonzero when the gateway call fails", async () => {
  mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
  const out = runtime();

  await sessionsUsageCommand({}, out);

  expect(out.error).toHaveBeenCalledWith("Usage read failed: gateway unavailable");
  expect(out.exit).toHaveBeenCalledWith(1);
});

it("emits the raw response as JSON", async () => {
  mocks.callGateway.mockResolvedValue(result());
  const out = runtime();

  await sessionsUsageCommand({ json: true }, out);

  expect(out.writeJson).toHaveBeenCalledWith(result(), 2);
  expect(out.log).not.toHaveBeenCalled();
});

it("formats an empty result without a table", () => {
  const text = renderSessionsUsage({
    ...result(),
    sessions: [],
    aggregates: { ...aggregates(), sessionCount: 0 },
  });
  expect(text).toContain("No session usage recorded in this range.");
  expect(text).toContain("Totals:");
});

it("labels unpriced rows and missing cost totals instead of printing zero", () => {
  const unpriced = {
    ...result(),
    totals: { ...totals(), missingCostEntries: 3 },
    sessions: [{ ...row(), usage: { ...totals(), totalCost: 0, missingCostEntries: 1 } }],
  };
  const text = renderSessionsUsage(unpriced);
  expect(text).toContain("unpriced");
  expect(text).toContain("Missing cost:");
});

it("renders computing rows distinctly and warns on non-fresh caches", () => {
  const computing = {
    ...result(),
    cacheStatus: { status: "refreshing" as const, cachedFiles: 0, pendingFiles: 1, staleFiles: 0 },
    sessions: [{ ...row(), usage: null, computing: true }],
  };
  const text = renderSessionsUsage(computing);
  expect(text).toContain("computing…");
  expect(text).toContain("incomplete (refreshing)");
});
