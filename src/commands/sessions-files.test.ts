import { beforeEach, expect, it, vi } from "vitest";
import { sessionsFilesCommand } from "./sessions-files.js";

const mocks = vi.hoisted(() => ({ callGateway: vi.fn(), writeFile: vi.fn() }));

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/gateway-rpc.js")>()),
  callGatewayFromCliWithTransport: mocks.callGateway,
}));

vi.mock("node:fs/promises", () => ({ writeFile: mocks.writeFile }));

function runtime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeStdout: vi.fn(), writeJson: vi.fn() };
}

function printed(out: ReturnType<typeof runtime>): string {
  return out.log.mock.calls.map(([line]) => String(line)).join("\n");
}

const listResult = () => ({
  sessionKey: "agent:main:main",
  root: "/ws",
  files: [
    {
      path: "src/index.ts",
      name: "index.ts",
      kind: "file",
      missing: false,
      size: 2048,
      updatedAtMs: 1,
    },
    { path: "notes", name: "notes", kind: "directory", missing: false },
  ],
  browser: { path: "src", entries: [{ path: "src/index.ts", name: "index.ts", kind: "file" }] },
});

beforeEach(() => vi.clearAllMocks());

it("lists session workspace files with sizes and dates", async () => {
  mocks.callGateway.mockResolvedValue(listResult());
  const out = runtime();

  await sessionsFilesCommand({ sessionKey: "agent:main:main" }, out);

  expect(mocks.callGateway).toHaveBeenCalledWith(
    "sessions.files.list",
    expect.objectContaining({ json: undefined }),
    { sessionKey: "agent:main:main" },
    expect.objectContaining({ defaultTimeoutMs: 30_000 }),
  );
  const text = printed(out);
  expect(text).toContain("src/index.ts");
  expect(text).toContain("2.0KB");
  expect(out.exit).not.toHaveBeenCalled();
});

it("forwards path, search, and agent selectors", async () => {
  mocks.callGateway.mockResolvedValue(listResult());
  const out = runtime();

  await sessionsFilesCommand(
    { sessionKey: "agent:work:main", path: "src", search: "index", agent: "work" },
    out,
  );

  expect(mocks.callGateway).toHaveBeenCalledWith(
    "sessions.files.list",
    expect.anything(),
    { sessionKey: "agent:work:main", agentId: "work", path: "src", search: "index" },
    expect.anything(),
  );
});

it("prints one file's content with --get", async () => {
  mocks.callGateway.mockResolvedValue({
    sessionKey: "agent:main:main",
    file: {
      path: "src/index.ts",
      name: "index.ts",
      kind: "file",
      missing: false,
      content: "export {};",
    },
  });
  const out = runtime();

  await sessionsFilesCommand(
    { sessionKey: "agent:main:main", path: "src/index.ts", get: true },
    out,
  );

  expect(mocks.callGateway).toHaveBeenCalledWith(
    "sessions.files.get",
    expect.anything(),
    { sessionKey: "agent:main:main", path: "src/index.ts" },
    expect.anything(),
  );
  expect(printed(out)).toContain("export {};");
});

it("writes fetched content to --output", async () => {
  mocks.callGateway.mockResolvedValue({
    sessionKey: "agent:main:main",
    file: { path: "data.csv", name: "data.csv", kind: "file", missing: false, content: "a,b" },
  });
  const out = runtime();

  await sessionsFilesCommand(
    { sessionKey: "agent:main:main", path: "data.csv", get: true, output: "data.csv" },
    out,
  );

  expect(mocks.writeFile).toHaveBeenCalledWith("data.csv", "a,b", "utf8");
  expect(printed(out)).toContain("Wrote data.csv");
});

it("rejects a blank session key and empty selectors before dispatch", async () => {
  await expect(sessionsFilesCommand({ sessionKey: "   " }, runtime())).rejects.toThrow(
    "Session key must not be blank.",
  );
  await expect(
    sessionsFilesCommand({ sessionKey: "agent:main:main", path: "  " }, runtime()),
  ).rejects.toThrow("Path must not be blank.");
  expect(mocks.callGateway).not.toHaveBeenCalled();
});

it("exits nonzero when the gateway call fails", async () => {
  mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
  const out = runtime();

  await sessionsFilesCommand({ sessionKey: "agent:main:main" }, out);

  expect(out.error).toHaveBeenCalledWith("Session files read failed: gateway unavailable");
  expect(out.exit).toHaveBeenCalledWith(1);
});

it("emits the raw response as JSON", async () => {
  mocks.callGateway.mockResolvedValue(listResult());
  const out = runtime();

  await sessionsFilesCommand({ sessionKey: "agent:main:main", json: true }, out);

  expect(out.writeJson).toHaveBeenCalledWith(listResult(), 2);
  expect(out.log).not.toHaveBeenCalled();
});
