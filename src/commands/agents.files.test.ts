import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  AgentsFilesGetResult,
  AgentsFilesListResult,
} from "../../packages/gateway-protocol/src/schema/agents-files.js";
import { agentsFilesGetCommand, agentsFilesListCommand } from "./agents.files.js";

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

const HASH = "a".repeat(64);

const listResult = (): AgentsFilesListResult => ({
  agentId: "main",
  workspace: "/state/workspace",
  files: [
    {
      name: "AGENTS.md",
      path: "/state/workspace/AGENTS.md",
      missing: false,
      size: 12,
      updatedAtMs: 1767323045000,
    },
    {
      name: "SOUL.md",
      path: "/state/workspace/SOUL.md",
      missing: false,
      size: 7,
      updatedAtMs: 1767323045000,
    },
    { name: "USER.md", path: "/state/workspace/USER.md", missing: true, expectedAbsent: true },
    { name: "BOOTSTRAP.md", path: "/state/workspace/BOOTSTRAP.md", missing: true },
    { name: "MEMORY.md", path: "/state/workspace/MEMORY.md", missing: true, expectedAbsent: true },
  ],
});

const getResult = (content = "hello"): AgentsFilesGetResult => ({
  agentId: "main",
  workspace: "/state/workspace",
  file: {
    name: "SOUL.md",
    path: "/state/workspace/SOUL.md",
    missing: false,
    size: Buffer.byteLength(content, "utf8"),
    updatedAtMs: 1767323045000,
    hash: HASH,
    content,
  },
});

const missingGetResult = (): AgentsFilesGetResult => ({
  agentId: "main",
  workspace: "/state/workspace",
  file: {
    name: "USER.md",
    path: "/state/workspace/USER.md",
    missing: true,
    expectedAbsent: true,
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

it("lists workspace documents with missing and optional classification", async () => {
  mocks.callGateway.mockResolvedValue(listResult());
  const out = runtime();

  await agentsFilesListCommand({ agent: "main" }, out);

  expect(mocks.callGateway).toHaveBeenCalledWith(
    "agents.files.list",
    expect.objectContaining({ json: undefined }),
    { agentId: "main" },
    expect.objectContaining({ defaultTimeoutMs: 30_000 }),
  );
  const text = printed(out);
  expect(text).toContain("Agent files");
  expect(text).toContain("AGENTS.md");
  expect(text).toContain("ok");
  expect(text).toContain("optional");
  expect(text).toContain("missing");
  expect(out.exit).not.toHaveBeenCalled();
});

it("resolves the configured default agent when --agent is omitted", async () => {
  mocks.callGateway.mockResolvedValue(listResult());
  const out = runtime();

  await agentsFilesListCommand({}, out);

  expect(mocks.resolveAgent).toHaveBeenCalledWith({}, undefined, {
    surface: "the agents files command",
    hint: "Pass --agent <id>.",
  });
  expect(mocks.callGateway).toHaveBeenCalledWith(
    "agents.files.list",
    expect.anything(),
    { agentId: "main" },
    expect.anything(),
  );
});

it("forwards an explicit agent id verbatim, including a blank one", async () => {
  mocks.callGateway.mockResolvedValue(listResult());
  const out = runtime();

  await agentsFilesListCommand({ agent: "" }, out);

  expect(mocks.resolveAgent).not.toHaveBeenCalled();
  expect(mocks.callGateway).toHaveBeenCalledWith(
    "agents.files.list",
    expect.anything(),
    { agentId: "" },
    expect.anything(),
  );
});

it("emits the untouched list result as JSON", async () => {
  const result = listResult();
  mocks.callGateway.mockResolvedValue(result);
  const out = runtime();

  await agentsFilesListCommand({ agent: "main", json: true }, out);

  expect(out.writeJson).toHaveBeenCalledWith(result, 2);
  expect(out.log).not.toHaveBeenCalled();
});

it("writes the exact document bytes to stdout without appending a newline", async () => {
  mocks.callGateway.mockResolvedValue(getResult("hello"));
  const stdout = captureStdout();
  const out = runtime();

  await agentsFilesGetCommand({ agent: "main", name: "SOUL.md" }, out);

  expect(writtenBytes(stdout)).toBe("hello");
  expect(stdout).toHaveBeenCalledTimes(1);
  expect(out.error).toHaveBeenCalledWith(
    expect.stringContaining(
      "sha256 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ),
  );
  expect(out.exit).not.toHaveBeenCalled();
});

it("keeps an empty document at zero bytes", async () => {
  mocks.callGateway.mockResolvedValue(getResult(""));
  const stdout = captureStdout();
  const out = runtime();

  await agentsFilesGetCommand({ agent: "main", name: "SOUL.md" }, out);

  expect(writtenBytes(stdout)).toBe("");
  expect(out.error).toHaveBeenCalledWith(expect.stringContaining("0 bytes"));
  expect(out.exit).not.toHaveBeenCalled();
});

it("leaves a document that already ends with a newline unchanged", async () => {
  mocks.callGateway.mockResolvedValue(getResult("hello\n"));
  const stdout = captureStdout();
  const out = runtime();

  await agentsFilesGetCommand({ agent: "main", name: "SOUL.md" }, out);

  expect(writtenBytes(stdout)).toBe("hello\n");
});

it("does not synthesize bytes when the Gateway returns no content", async () => {
  mocks.callGateway.mockResolvedValue({
    agentId: "main",
    workspace: "/state/workspace",
    file: {
      name: "SOUL.md",
      path: "/state/workspace/SOUL.md",
      missing: false,
      size: 5,
      hash: HASH,
    },
  } satisfies AgentsFilesGetResult);
  const stdout = captureStdout();
  const out = runtime();

  await agentsFilesGetCommand({ agent: "main", name: "SOUL.md" }, out);

  expect(stdout).not.toHaveBeenCalled();
  expect(out.error).toHaveBeenCalledWith(expect.stringContaining("returned no content"));
  expect(out.exit).not.toHaveBeenCalled();
});

it("treats an absent optional document as a normal state", async () => {
  mocks.callGateway.mockResolvedValue(missingGetResult());
  const stdout = captureStdout();
  const out = runtime();

  await agentsFilesGetCommand({ agent: "main", name: "USER.md" }, out);

  expect(stdout).not.toHaveBeenCalled();
  expect(out.error).toHaveBeenCalledWith(expect.stringContaining("optional and not present"));
  expect(out.exit).not.toHaveBeenCalled();
});

it("reports a rejected document name and exits nonzero", async () => {
  mocks.callGateway.mockRejectedValue(new Error('unsupported file "../etc/passwd"'));
  const out = runtime();

  await agentsFilesGetCommand({ agent: "main", name: "../etc/passwd" }, out);

  expect(out.error).toHaveBeenCalledWith(
    'Agent file read failed: unsupported file "../etc/passwd"',
  );
  expect(out.exit).toHaveBeenCalledWith(1);
});

it("emits the untouched get result as JSON", async () => {
  const result = getResult();
  mocks.callGateway.mockResolvedValue(result);
  const stdout = captureStdout();
  const out = runtime();

  await agentsFilesGetCommand({ agent: "main", name: "SOUL.md", json: true }, out);

  expect(out.writeJson).toHaveBeenCalledWith(result, 2);
  expect(stdout).not.toHaveBeenCalled();
});
