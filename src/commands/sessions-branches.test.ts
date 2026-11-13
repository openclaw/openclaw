import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMockCallOutput } from "../cli/test-runtime-capture.js";
import { createNonExitingRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
import { sessionsBranchesCommand } from "./sessions-branches.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/gateway-rpc.js")>()),
  callGatewayFromCliWithTransport: mocks.callGateway,
}));

function branches(...rows: Array<Record<string, unknown>>) {
  return { branches: rows };
}

function branch(overrides: Record<string, unknown> = {}) {
  return {
    leafEntryId: "entry-1",
    headline: "latest",
    messageCount: 4,
    active: true,
    ...overrides,
  };
}

describe("sessionsBranchesCommand", () => {
  let runtime: ReturnType<typeof createNonExitingRuntimeEnv>;

  const run = (opts: Parameters<typeof sessionsBranchesCommand>[0]) =>
    sessionsBranchesCommand(opts, runtime);
  const joinedArgs = (channel: "log" | "error") => getMockCallOutput(vi.mocked(runtime[channel]));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callGateway.mockReset();
    runtime = createNonExitingRuntimeEnv();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("forwards sessionKey and agentId through the canonical RPC", async () => {
    mocks.callGateway.mockResolvedValueOnce(branches());
    await run({ key: "agent:work:main", agent: "work" });
    expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith(
      "sessions.branches.list",
      expect.any(Object),
      { sessionKey: "agent:work:main", agentId: "work" },
      { defaultTimeoutMs: 30_000 },
    );
  });

  it("omits agentId and leaves the timeout unset when unspecified", async () => {
    mocks.callGateway.mockResolvedValueOnce(branches());
    await run({ key: "agent:main:main" });
    const [, rpcOpts, params] = expectDefined(mocks.callGateway.mock.calls[0], "branches RPC call");
    expect(params).toEqual({ sessionKey: "agent:main:main" });
    expect(rpcOpts).not.toHaveProperty("timeout");
  });

  it("emits the raw result envelope for --json", async () => {
    const payload = branches(
      branch({ leafEntryId: "entry-1", active: true }),
      branch({ leafEntryId: "entry-2", headline: "checkpoint", messageCount: 2, active: false }),
    );
    mocks.callGateway.mockResolvedValueOnce(payload);
    await run({ key: "agent:main:main", json: true });
    expect(runtime.writeJson).toHaveBeenCalledWith(payload, 2);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("renders branch rows with an active marker and message count", async () => {
    mocks.callGateway.mockResolvedValueOnce(
      branches(
        branch({ leafEntryId: "entry-1", active: true, headline: "latest" }),
        branch({ leafEntryId: "entry-2", active: false, headline: "checkpoint", messageCount: 2 }),
      ),
    );
    await run({ key: "agent:main:main" });
    expect(joinedArgs("log")).toContain("* entry-1 (4 messages) — latest");
    expect(joinedArgs("log")).toContain("  entry-2 (2 messages) — checkpoint");
  });

  it("reports an empty branch set without failing", async () => {
    mocks.callGateway.mockResolvedValueOnce(branches());
    await run({ key: "agent:main:main" });
    expect(joinedArgs("log")).toContain("No branches found for session agent:main:main.");
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("exits nonzero on a gateway failure", async () => {
    mocks.callGateway.mockRejectedValueOnce(new Error("gateway down"));
    await run({ key: "agent:main:main" });
    expect(joinedArgs("error")).toContain("Failed to list branches");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("escapes terminal controls in text output", async () => {
    mocks.callGateway.mockResolvedValueOnce(
      branches(branch({ headline: "latest\u001b[2J\nnext", leafEntryId: "entry\u0007x" })),
    );
    await run({ key: "agent:main:main" });
    const output = `${joinedArgs("log")}${joinedArgs("error")}`;
    for (const control of ["\u0007", "\u001b", "\r"]) {
      expect(output).not.toContain(control);
    }
  });

  it("rejects a blank --agent before contacting the gateway", async () => {
    await expect(run({ key: "agent:main:main", agent: "   " })).rejects.toThrow(
      "--agent must not be blank",
    );
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });
});
