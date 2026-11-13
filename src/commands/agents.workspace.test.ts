import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  AgentsWorkspaceGetResult,
  AgentsWorkspaceListResult,
} from "../../packages/gateway-protocol/src/schema/agents-workspace.js";
import { agentsWorkspaceGetCommand, agentsWorkspaceListCommand } from "./agents.workspace.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  resolveAgent: vi.fn(() => "main"),
  readConfig: vi.fn(async () => ({})),
}));

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/gateway-rpc.js")>()),
  callGatewayFromCliWithTransport: mocks.callGateway,
}));
// mock-isolation: default-agent selection must not read the developer's real config.
vi.mock("../agents/agent-scope-config.js", () => ({
  resolveAgentOperationAgentId: mocks.resolveAgent,
}));
// mock-isolation: default-agent selection must not read the developer's real config.
vi.mock("../config/config.js", () => ({
  captureRuntimeConfigAsyncReader: () => mocks.readConfig,
}));

function runtime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeStdout: vi.fn(), writeJson: vi.fn() };
}

function printed(out: ReturnType<typeof runtime>): string {
  return out.log.mock.calls.map(([line]) => String(line)).join("\n");
}

/** Runtime whose JSON writer serializes the value, so tests read the real payload. */
function jsonRuntime() {
  const chunks: string[] = [];
  return {
    out: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn((value: unknown, space?: number) => {
        chunks.push(JSON.stringify(value, undefined, space));
      }),
    },
    written: () => chunks.join(""),
  };
}

const listResult = (): AgentsWorkspaceListResult => ({
  agentId: "main",
  path: "notes",
  parentPath: "",
  entries: [
    { path: "notes/a.md", name: "a.md", kind: "file", size: 42, updatedAtMs: 1767323045000 },
    { path: "notes/sub", name: "sub", kind: "directory" },
  ],
  totalEntries: 7,
  offset: 2,
});

const getResult = (content = "hello\n", encoding: "utf8" | "base64" = "utf8") => ({
  agentId: "main",
  file: {
    path: "notes/a.md",
    name: "a.md",
    size: Buffer.byteLength(content, "utf8"),
    updatedAtMs: 1767323045000,
    mimeType: encoding === "base64" ? "image/png" : "text/plain",
    encoding,
    content,
  },
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

/** Capture the bytes the command actually hands to stdout. */
function captureStdout() {
  return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

function writtenBytes(stdout: ReturnType<typeof captureStdout>): string {
  return stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
}

it("lists a workspace directory and renders files next to directories", async () => {
  mocks.callGateway.mockResolvedValue(listResult());
  const out = runtime();

  await agentsWorkspaceListCommand({ agent: "main", path: "notes" }, out);

  expect(mocks.callGateway).toHaveBeenCalledWith(
    "agents.workspace.list",
    expect.objectContaining({ json: undefined }),
    { agentId: "main", path: "notes" },
    expect.objectContaining({ defaultTimeoutMs: 30_000 }),
  );
  const text = printed(out);
  expect(text).toContain("Agent workspace");
  expect(text).toContain("notes");
  expect(text).toContain("7 entries");
  expect(text).toContain("a.md");
  expect(text).toContain("sub");
  expect(text).toContain("directory");
  expect(out.exit).not.toHaveBeenCalled();
});

it("forwards offset and limit as numbers, not strings", async () => {
  mocks.callGateway.mockResolvedValue(listResult());
  const out = runtime();

  await agentsWorkspaceListCommand({ agent: "main", offset: "2", limit: "5" }, out);

  expect(mocks.callGateway).toHaveBeenCalledWith(
    "agents.workspace.list",
    expect.anything(),
    { agentId: "main", offset: 2, limit: 5 },
    expect.anything(),
  );
});

it("rejects a non-numeric limit before calling the Gateway", async () => {
  const out = runtime();

  await agentsWorkspaceListCommand({ agent: "main", limit: "many" }, out);

  expect(mocks.callGateway).not.toHaveBeenCalled();
  expect(out.error).toHaveBeenCalledWith(
    "Agent workspace list failed: --limit must be an integer >= 1",
  );
  expect(out.exit).toHaveBeenCalledWith(1);
});

it("keeps the JSON failure envelope for invalid pagination options", async () => {
  const { out, written } = jsonRuntime();

  await agentsWorkspaceListCommand({ agent: "main", offset: "-1", json: true }, out);

  expect(mocks.callGateway).not.toHaveBeenCalled();
  expect(JSON.parse(written())).toEqual({
    ok: false,
    error: { type: "cli_error", message: "--offset must be an integer >= 0" },
  });
  expect(out.log).not.toHaveBeenCalled();
  expect(out.exit).toHaveBeenCalledWith(1);
});

it("forwards an explicit agent id verbatim, including a blank one", async () => {
  mocks.callGateway.mockResolvedValue(listResult());
  const out = runtime();

  await agentsWorkspaceListCommand({ agent: "" }, out);

  expect(mocks.resolveAgent).not.toHaveBeenCalled();
  expect(mocks.callGateway).toHaveBeenCalledWith(
    "agents.workspace.list",
    expect.anything(),
    { agentId: "" },
    expect.anything(),
  );
});

it("serializes the untouched list result as JSON", async () => {
  const result = listResult();
  mocks.callGateway.mockResolvedValue(result);
  const { out, written } = jsonRuntime();

  await agentsWorkspaceListCommand({ agent: "main", json: true }, out);

  expect(JSON.parse(written())).toEqual(result);
  expect(out.log).not.toHaveBeenCalled();
  expect(out.error).not.toHaveBeenCalled();
});

it("writes the exact file bytes to stdout and metadata to stderr", async () => {
  mocks.callGateway.mockResolvedValue(getResult("hello\n"));
  const stdout = captureStdout();
  const out = runtime();

  await agentsWorkspaceGetCommand({ agent: "main", path: "notes/a.md" }, out);

  expect(writtenBytes(stdout)).toBe("hello\n");
  expect(stdout).toHaveBeenCalledTimes(1);
  expect(out.error).toHaveBeenCalledWith(
    expect.stringContaining("notes/a.md, 6 bytes, text/plain, encoding=utf8"),
  );
  expect(out.exit).not.toHaveBeenCalled();
});

it("keeps a file without a trailing newline at exactly its own bytes", async () => {
  mocks.callGateway.mockResolvedValue(getResult("hello"));
  const stdout = captureStdout();
  const out = runtime();

  await agentsWorkspaceGetCommand({ agent: "main", path: "notes/a.md" }, out);

  expect(writtenBytes(stdout)).toBe("hello");
  expect(out.exit).not.toHaveBeenCalled();
});

it("writes base64 payloads unchanged and reports the encoding", async () => {
  const payload = "iVBORw0KGgo=";
  mocks.callGateway.mockResolvedValue(getResult(payload, "base64"));
  const stdout = captureStdout();
  const out = runtime();

  await agentsWorkspaceGetCommand({ agent: "main", path: "notes/pixel.png" }, out);

  expect(writtenBytes(stdout)).toBe(payload);
  expect(out.error).toHaveBeenCalledWith(expect.stringContaining("encoding=base64"));
});

it("serializes the untouched get result as JSON", async () => {
  const result = getResult() satisfies AgentsWorkspaceGetResult;
  mocks.callGateway.mockResolvedValue(result);
  const stdout = captureStdout();
  const { out, written } = jsonRuntime();

  await agentsWorkspaceGetCommand({ agent: "main", path: "notes/a.md", json: true }, out);

  expect(JSON.parse(written())).toEqual(result);
  expect(stdout).not.toHaveBeenCalled();
  expect(out.error).not.toHaveBeenCalled();
});

it("reports a Gateway path rejection and exits nonzero", async () => {
  mocks.callGateway.mockRejectedValue(new Error("path escapes the agent workspace"));
  const out = runtime();

  await agentsWorkspaceGetCommand({ agent: "main", path: "../etc/passwd" }, out);

  expect(out.error).toHaveBeenCalledWith(
    "Agent workspace file failed: path escapes the agent workspace",
  );
  expect(out.exit).toHaveBeenCalledWith(1);
});

it("emits a JSON failure envelope when the Gateway rejects a path", async () => {
  mocks.callGateway.mockRejectedValue(new Error("path escapes the agent workspace"));
  const { out, written } = jsonRuntime();

  await agentsWorkspaceGetCommand({ agent: "main", path: "../etc/passwd", json: true }, out);

  expect(JSON.parse(written())).toEqual({
    ok: false,
    error: { type: "cli_error", message: "path escapes the agent workspace" },
  });
  expect(out.exit).toHaveBeenCalledWith(1);
});
