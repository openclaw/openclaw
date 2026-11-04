import { beforeEach, expect, it, vi } from "vitest";
import { agentsToolsCommand } from "./agents-tools.js";

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

const result = () => ({
  agentId: "main",
  profile: "coding",
  groups: [{ id: "core", label: "Core", source: "core", tools: [] }],
  notices: [
    {
      id: "quarantined",
      severity: "warning",
      message: "One tool schema was quarantined.",
      servers: ["mcp-demo"],
    },
  ],
  toolAccess: {
    checked: "live-session",
    profiles: [{ profile: "coding", source: "agents.main.tools", active: true }],
    tools: [
      {
        id: "exec",
        status: "allowed",
        reasons: [{ kind: "profile", label: "included by coding profile" }],
      },
      {
        id: "message",
        status: "excluded",
        reasons: [{ kind: "deny", label: "denied", source: "agents.main.tools.deny" }],
      },
    ],
  },
});

beforeEach(() => vi.clearAllMocks());

it("forwards the session key and agent to the gateway", async () => {
  mocks.callGateway.mockResolvedValue(result());
  const out = runtime();

  await agentsToolsCommand({ sessionKey: "agent:main:main", agent: "main" }, out);

  expect(mocks.callGateway).toHaveBeenCalledWith(
    "tools.effective",
    expect.objectContaining({ json: undefined }),
    { sessionKey: "agent:main:main", agentId: "main" },
    expect.objectContaining({ defaultTimeoutMs: 30_000 }),
  );
  const text = printed(out);
  expect(text).toContain("Effective tools");
  expect(text).toContain("excluded");
  expect(text).toContain("denied");
  expect(text).toContain("quarantined");
  expect(out.exit).not.toHaveBeenCalled();
});

it("rejects a blank session key before dispatch", async () => {
  await expect(agentsToolsCommand({ sessionKey: "   " }, runtime())).rejects.toThrow(
    "Session key must not be blank.",
  );
  expect(mocks.callGateway).not.toHaveBeenCalled();
});

it("exits nonzero when the gateway call fails", async () => {
  mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
  const out = runtime();

  await agentsToolsCommand({ sessionKey: "agent:main:main" }, out);

  expect(out.error).toHaveBeenCalledWith("Tools diagnostics failed: gateway unavailable");
  expect(out.exit).toHaveBeenCalledWith(1);
});

it("emits the raw response as JSON", async () => {
  mocks.callGateway.mockResolvedValue(result());
  const out = runtime();

  await agentsToolsCommand({ sessionKey: "agent:main:main", json: true }, out);

  expect(out.writeJson).toHaveBeenCalledWith(result(), 2);
  expect(out.log).not.toHaveBeenCalled();
});

it("falls back to group counts when tool access diagnostics are absent", async () => {
  mocks.callGateway.mockResolvedValue({
    ...result(),
    toolAccess: undefined,
    groups: [
      {
        id: "core",
        label: "Core",
        source: "core",
        tools: [
          { id: "read", label: "Read", description: "d", rawDescription: "d", source: "core" },
          { id: "write", label: "Write", description: "d", rawDescription: "d", source: "core" },
        ],
      },
    ],
  });
  const out = runtime();

  await agentsToolsCommand({ sessionKey: "agent:main:main" }, out);

  expect(printed(out)).toContain("Core: 2 tools");
});
