// Tests for node.pair.approve unknown requestId hint (fixes #94040).
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCallPairApprovalGateway = vi.fn();
const mockParsePairingList = vi.fn(() => ({ pending: [], paired: [] }));
const mockError = vi.fn();
const mockExit = vi.fn();
const mockWriteJson = vi.fn();
const mockWriteStdout = vi.fn();
const mockLog = vi.fn();

vi.mock("./rpc.js", () => ({
  callGatewayCli: vi.fn(),
  callNodePairApprovalGatewayCli: (...args: unknown[]) =>
    mockCallPairApprovalGateway(...args),
  nodesCallOpts: (cmd: Command) => cmd,
  resolveNodeId: vi.fn(),
}));

vi.mock("./format.js", () => ({
  parsePairingList: (...args: unknown[]) => mockParsePairingList(...args),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: (...args: unknown[]) => mockLog(...args),
    error: (...args: unknown[]) => mockError(...args),
    writeJson: (...args: unknown[]) => mockWriteJson(...args),
    writeStdout: (...args: unknown[]) => mockWriteStdout(...args),
    exit: (...args: unknown[]) => mockExit(...args),
  },
}));

const { registerNodesPairingCommands } =
  await import("./register.pairing.js");

function createApproveProgram() {
  const program = new Command();
  program.name("test");
  program.exitOverride();
  const nodes = program.command("nodes");
  registerNodesPairingCommands(nodes);
  return program;
}

function createGatewayUnknownRequestIdError(): Error {
  const error = new Error("unknown requestId");
  error.name = "GatewayClientRequestError";
  (error as Error & { gatewayCode: string }).gatewayCode = "INVALID_REQUEST";
  return error;
}

describe("nodes approve unknown requestId hint", () => {
  beforeEach(() => {
    mockCallPairApprovalGateway.mockReset();
    mockParsePairingList.mockReset();
    mockParsePairingList.mockReturnValue({ pending: [], paired: [] });
    mockError.mockReset();
    mockExit.mockReset();
    mockWriteJson.mockReset();
    mockWriteStdout.mockReset();
    mockLog.mockReset();
  });

  it("shows pending requestIds when approve fails with unknown requestId", async () => {
    // First call: resolveApproveScopesForRequest → node.pair.list
    mockCallPairApprovalGateway.mockResolvedValueOnce({});
    mockParsePairingList.mockReturnValueOnce({
      pending: [
        { requestId: "req-abc", nodeId: "n1" },
        { requestId: "req-def", nodeId: "n2" },
      ],
      paired: [],
    });
    // Second call: approve throws unknown requestId
    mockCallPairApprovalGateway.mockRejectedValueOnce(
      createGatewayUnknownRequestIdError(),
    );
    // Third call: buildUnknownRequestIdHint → node.pair.list
    mockCallPairApprovalGateway.mockResolvedValueOnce({});
    mockParsePairingList.mockReturnValueOnce({
      pending: [
        { requestId: "req-abc", nodeId: "n1" },
        { requestId: "req-def", nodeId: "n2" },
      ],
      paired: [],
    });

    const program = createApproveProgram();
    try {
      await program.parseAsync(["nodes", "approve", "stale-request"], {
        from: "user",
      });
    } catch {
      // exitOverride converts exit(1) to CommanderError
    }

    expect(mockError).toHaveBeenCalled();
    const errorCalls = mockError.mock.calls.flat() as string[];
    const errorText = errorCalls.join(" ");
    expect(errorText).toContain(
      "Unknown node pairing requestId: stale-request",
    );
    expect(errorText).toContain("req-abc");
    expect(errorText).toContain("req-def");
    expect(errorText).toContain("openclaw nodes pending");
  });

  it("shows fallback when list fails during hint building", async () => {
    // resolveApproveScopesForRequest list fails silently
    mockCallPairApprovalGateway.mockRejectedValueOnce(new Error("gateway down"));
    // approve fails with unknown requestId
    mockCallPairApprovalGateway.mockRejectedValueOnce(
      createGatewayUnknownRequestIdError(),
    );
    // buildUnknownRequestIdHint list also fails
    mockCallPairApprovalGateway.mockRejectedValueOnce(new Error("gateway down"));

    const program = createApproveProgram();
    try {
      await program.parseAsync(["nodes", "approve", "orphan-request"], {
        from: "user",
      });
    } catch {
      // exitOverride
    }

    expect(mockError).toHaveBeenCalled();
    const errorCalls = mockError.mock.calls.flat() as string[];
    const errorText = errorCalls.join(" ");
    expect(errorText).toContain(
      "Unknown node pairing requestId: orphan-request",
    );
    expect(errorText).toContain(
      "No pending node pairing requests are currently visible",
    );
  });

  it("does not intercept non-unknown-requestId errors", async () => {
    mockCallPairApprovalGateway.mockResolvedValueOnce({});
    mockParsePairingList.mockReturnValueOnce({ pending: [], paired: [] });
    mockCallPairApprovalGateway.mockRejectedValueOnce(
      new Error("some other error"),
    );

    const program = createApproveProgram();
    try {
      await program.parseAsync(["nodes", "approve", "req-1"], {
        from: "user",
      });
    } catch {
      // exitOverride
    }

    expect(mockError).toHaveBeenCalled();
    const errorCalls = mockError.mock.calls.flat() as string[];
    const errorText = errorCalls.join(" ");
    expect(errorText).toContain("some other error");
    expect(errorText).not.toContain("openclaw nodes pending");
  });
});
