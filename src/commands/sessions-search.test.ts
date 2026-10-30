import { beforeEach, expect, it, vi } from "vitest";
import { renderSessionsSearch, sessionsSearchCommand } from "./sessions-search.js";

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

const hit = (overrides: Record<string, unknown> = {}) => ({
  sessionKey: "agent:main:main",
  sessionId: "sess-1",
  messageId: "msg-1",
  role: "assistant",
  timestamp: 1_700_000_000_000,
  snippet: "I changed the cron schedule for the nightly backup.",
  score: 0.8,
  ...overrides,
});

beforeEach(() => vi.clearAllMocks());

it("forwards the query and default options to the gateway", async () => {
  mocks.callGateway.mockResolvedValue({ results: [] });
  const out = runtime();

  await sessionsSearchCommand({ query: "cron schedule" }, out);

  expect(mocks.callGateway).toHaveBeenCalledWith(
    "sessions.search",
    expect.objectContaining({ json: undefined }),
    { query: "cron schedule" },
    expect.objectContaining({ defaultTimeoutMs: 30_000 }),
  );
  expect(printed(out)).toContain('No transcript matches for "cron schedule".');
  expect(out.exit).not.toHaveBeenCalled();
});

it("forwards explicit keys, agent, and active-minutes scope", async () => {
  mocks.callGateway.mockResolvedValue({ results: [] });
  const out = runtime();

  await sessionsSearchCommand(
    {
      query: "backup",
      agent: "work",
      keys: ["agent:work:main", " agent:work:scratch"],
      limit: 25,
      activeMinutes: 60,
    },
    out,
  );

  expect(mocks.callGateway).toHaveBeenCalledWith(
    "sessions.search",
    expect.anything(),
    {
      query: "backup",
      agentId: "work",
      sessionKeys: ["agent:work:main", "agent:work:scratch"],
      limit: 25,
      scope: { activeMinutes: 60 },
    },
    expect.anything(),
  );
});

it("caps the limit at the gateway maximum", async () => {
  mocks.callGateway.mockResolvedValue({ results: [] });
  const out = runtime();

  await sessionsSearchCommand({ query: "x", limit: 100 }, out);

  const params = mocks.callGateway.mock.calls[0]?.[2] as { limit: number };
  expect(params.limit).toBe(25);
});

it("renders matches with snippets and scores", async () => {
  mocks.callGateway.mockResolvedValue({
    results: [hit({ role: "user", snippet: "Where did the backup land?" }), hit({ score: 0.5 })],
  });
  const out = runtime();

  await sessionsSearchCommand({ query: "backup" }, out);

  const text = printed(out);
  expect(text).toContain("Transcript matches (2)");
  expect(text).toContain("Where did the backup land?");
  expect(text).toContain("0.800");
  expect(text).toContain("0.500");
});

it("notes an in-progress index and truncation instead of silence", async () => {
  mocks.callGateway.mockResolvedValue({
    results: [hit()],
    indexing: true,
    truncated: true,
    archivedTranscriptsExcluded: 3,
  });
  const out = runtime();

  await sessionsSearchCommand({ query: "x" }, out);

  const text = printed(out);
  expect(text).toContain("still reconciling");
  expect(text).toContain("raise --limit");
  expect(text).toContain("3 archived transcript(s) excluded");
});

it("rejects an empty query before dispatch", async () => {
  await expect(sessionsSearchCommand({ query: "   " }, runtime())).rejects.toThrow(
    "Query must not be empty.",
  );
  expect(mocks.callGateway).not.toHaveBeenCalled();
});

it("exits nonzero when the gateway call fails", async () => {
  mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
  const out = runtime();

  await sessionsSearchCommand({ query: "x" }, out);

  expect(out.error).toHaveBeenCalledWith("Search failed: gateway unavailable");
  expect(out.exit).toHaveBeenCalledWith(1);
});

it("emits the raw response as JSON", async () => {
  mocks.callGateway.mockResolvedValue({ results: [hit()] });
  const out = runtime();

  await sessionsSearchCommand({ query: "x", json: true }, out);

  expect(out.writeJson).toHaveBeenCalledWith({ results: [hit()] }, 2);
  expect(out.log).not.toHaveBeenCalled();
});

it("formats an empty result set without a table", () => {
  expect(renderSessionsSearch({ results: [] }, "nothing")).toBe(
    'No transcript matches for "nothing".',
  );
});
