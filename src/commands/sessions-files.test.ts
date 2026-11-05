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
      size: 4096,
      updatedAtMs: 1,
    },
    { path: "notes", name: "notes", kind: "directory", missing: false },
  ],
  browser: {
    path: "src",
    entries: [
      {
        path: "src/index.ts",
        name: "index.ts",
        kind: "file",
        size: 2048,
        updatedAtMs: 2,
      },
    ],
    truncated: true,
  },
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
  // Browser selection wins: only the selected inventory renders, with browser metadata.
  expect(text).toContain("src/index.ts");
  expect(text).not.toContain("notes");
  expect(text).toContain("2.0KB");
  expect(text).not.toContain("4.0KB");
  expect(text).toContain("truncated");
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

it("rejects unsupported preview content before writing an output file", async () => {
  mocks.callGateway.mockResolvedValue({
    sessionKey: "agent:main:main",
    file: { path: "video.mp4", name: "video.mp4", kind: "file", missing: false },
  });
  const out = runtime();

  await sessionsFilesCommand(
    { sessionKey: "agent:main:main", path: "video.mp4", get: true, output: "video.mp4" },
    out,
  );

  expect(out.error).toHaveBeenCalledWith(
    "File video.mp4 has no inline content (unsupported preview); nothing was written.",
  );
  expect(out.exit).toHaveBeenCalledWith(1);
});

it("rejects encoded preview content before writing an output file", async () => {
  mocks.callGateway.mockResolvedValue({
    sessionKey: "agent:main:main",
    file: {
      path: "chart.png",
      name: "chart.png",
      kind: "file",
      missing: false,
      content: "iVBORw0KGgo=",
      contentEncoding: "base64",
      previewKind: "image",
    },
  });
  const out = runtime();

  await sessionsFilesCommand(
    { sessionKey: "agent:main:main", path: "chart.png", get: true, output: "chart.png" },
    out,
  );

  expect(out.error).toHaveBeenCalledWith(
    "File chart.png has base64-encoded content; --output supports text content only, so nothing was written.",
  );
  expect(out.exit).toHaveBeenCalledWith(1);
  expect(mocks.writeFile).not.toHaveBeenCalled();
});

it("reports missing inline content for stdout reads", async () => {
  mocks.callGateway.mockResolvedValue({
    sessionKey: "agent:main:main",
    file: {
      path: "video.mp4",
      name: "video.mp4",
      kind: "file",
      missing: false,
      previewKind: "unsupported",
    },
  });
  const out = runtime();

  await sessionsFilesCommand({ sessionKey: "agent:main:main", path: "video.mp4", get: true }, out);

  expect(out.error).toHaveBeenCalledWith(
    "File video.mp4 has no inline content (unsupported preview).",
  );
  expect(out.exit).toHaveBeenCalledWith(1);
  expect(out.log).not.toHaveBeenCalled();
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
