import { beforeEach, expect, it, vi } from "vitest";
import { describeSessionsDiff, sessionsDiffCommand } from "./sessions-diff.js";

const mocks = vi.hoisted(() => ({ callGateway: vi.fn() }));

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/gateway-rpc.js")>()),
  callGatewayFromCliWithTransport: mocks.callGateway,
}));

const key = "agent:main:main";

function runtime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeJson: vi.fn(),
  };
}

function printed(out: ReturnType<typeof runtime>): string {
  return String(out.log.mock.calls[0]?.[0] ?? "");
}

beforeEach(() => vi.clearAllMocks());

it("prints the branch, commits, files, and totals", async () => {
  mocks.callGateway.mockResolvedValue({
    sessionKey: key,
    branch: "fix/session-diff",
    baseRef: "main",
    aheadCount: 2,
    commits: [{ sha: "abc1234", subject: "feat(sessions): add a diff view" }],
    files: [
      { path: "src/a.ts", status: "M", additions: 4, deletions: 1 },
      { path: "src/new.ts", status: "A", additions: 10, deletions: 0, untracked: true },
    ],
    additions: 14,
    deletions: 1,
  });
  const out = runtime();

  await sessionsDiffCommand({ key }, out);

  expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith(
    "sessions.diff",
    expect.objectContaining({ json: undefined }),
    { sessionKey: key },
    expect.objectContaining({ defaultTimeoutMs: 30_000 }),
  );
  const text = printed(out);
  expect(text).toContain(`Diff for ${key} on fix/session-diff (base main, 2 commits ahead)`);
  expect(text).toContain("abc1234 feat(sessions): add a diff view");
  expect(text).toContain("M src/a.ts  +4 -1");
  expect(text).toContain("A src/new.ts  +10 -0  (untracked)");
  expect(text).toContain("2 files changed, +14 -1.");
  expect(out.exit).not.toHaveBeenCalled();
});

it("forwards the scope, commit, agent, and summary options", async () => {
  mocks.callGateway.mockResolvedValue({ sessionKey: key, files: [], additions: 0, deletions: 0 });
  const out = runtime();

  await sessionsDiffCommand(
    { key, agent: "work", scope: "commit", commit: "HEAD~1", summary: true },
    out,
  );

  expect(mocks.callGateway).toHaveBeenCalledWith(
    "sessions.diff",
    expect.anything(),
    { sessionKey: key, agentId: "work", scope: "commit", commit: "HEAD~1", summaryOnly: true },
    expect.anything(),
  );
  expect(printed(out)).toContain("No changed files.");
});

it("reports an unavailable workspace and exits nonzero", async () => {
  mocks.callGateway.mockResolvedValue({
    sessionKey: key,
    files: [],
    additions: 0,
    deletions: 0,
    unavailableReason: "workspace_stopped",
  });
  const out = runtime();

  await sessionsDiffCommand({ key }, out);

  expect(out.error).toHaveBeenCalledWith(
    `Session ${key}'s workspace is stopped. Start it on the Gateway and retry.`,
  );
  expect(out.exit).toHaveBeenCalledWith(1);
  expect(out.log).not.toHaveBeenCalled();
});

it("says a computing diff is not an empty one", async () => {
  mocks.callGateway.mockResolvedValue({
    sessionKey: key,
    files: [],
    additions: 0,
    deletions: 0,
    computing: true,
  });
  const out = runtime();

  await sessionsDiffCommand({ key }, out);

  expect(printed(out)).toContain("still computing");
  expect(out.exit).not.toHaveBeenCalled();
});

it("rejects a commit selector without the commit scope", async () => {
  await expect(sessionsDiffCommand({ key, commit: "HEAD~1" }, runtime())).rejects.toThrow(
    "--commit requires --scope commit.",
  );
  await expect(sessionsDiffCommand({ key, scope: "commit" }, runtime())).rejects.toThrow(
    "--scope commit requires --commit <sha>.",
  );
  await expect(sessionsDiffCommand({ key, scope: "sideways" }, runtime())).rejects.toThrow(
    "--scope must be one of all, uncommitted, commit.",
  );
  expect(mocks.callGateway).not.toHaveBeenCalled();
});

it("exits nonzero when the gateway call fails", async () => {
  mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
  const out = runtime();

  await sessionsDiffCommand({ key }, out);

  expect(out.error).toHaveBeenCalledWith("Diff failed: gateway unavailable");
  expect(out.exit).toHaveBeenCalledWith(1);
});

it("formats a truncated file list without hiding the totals", () => {
  const text = describeSessionsDiff(
    {
      sessionKey: key,
      files: [{ path: "a.ts", status: "M", additions: 1, deletions: 2, truncated: true }],
      additions: 1,
      deletions: 2,
      truncated: true,
    },
    key,
  );

  expect(text).toContain("1 file changed, +1 -2.");
  expect(text).toContain("rerun with --json for the complete response.");
});
