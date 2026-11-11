// Verify the `sessions reactions` CLI forwards the canonical reaction-list RPC
// and keeps empty, JSON, failure, and terminal-safety behavior explicit.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMockCallOutput } from "../cli/test-runtime-capture.js";
import { createNonExitingRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
import { sessionsReactionsCommand } from "./sessions-reactions.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/gateway-rpc.js")>()),
  callGatewayFromCliWithTransport: mocks.callGateway,
}));

function reactions(rows: Record<string, Array<Record<string, unknown>>>) {
  return { sessionId: "session-1", reactions: rows };
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    emoji: "👍",
    count: 2,
    identities: [{ id: "user-1", label: "Ada" }],
    ...overrides,
  };
}

describe("sessionsReactionsCommand", () => {
  let runtime: ReturnType<typeof createNonExitingRuntimeEnv>;

  const run = (opts: Parameters<typeof sessionsReactionsCommand>[0]) =>
    sessionsReactionsCommand(opts, runtime);
  const joinedArgs = (channel: "log" | "error") => getMockCallOutput(vi.mocked(runtime[channel]));

  beforeEach(() => {
    mocks.callGateway.mockReset();
    runtime = createNonExitingRuntimeEnv();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("forwards sessionKey and agentId through the canonical read-only RPC", async () => {
    mocks.callGateway.mockResolvedValueOnce(reactions({}));
    await run({ key: "agent:work:main", agent: "work" });
    expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith(
      "session.reactions.list",
      expect.any(Object),
      { sessionKey: "agent:work:main", agentId: "work" },
      { defaultTimeoutMs: 30_000, sharedStateMode: "read-only" },
    );
  });

  it("omits agentId and keeps the read-only policy when unspecified", async () => {
    mocks.callGateway.mockResolvedValueOnce(reactions({}));
    await run({ key: "agent:main:main" });
    const [, rpcOpts, params, transport] = expectDefined(
      mocks.callGateway.mock.calls[0],
      "reactions RPC call",
    );
    expect(params).toEqual({ sessionKey: "agent:main:main" });
    expect(rpcOpts).not.toHaveProperty("timeout");
    expect(transport).toEqual({ defaultTimeoutMs: 30_000, sharedStateMode: "read-only" });
  });

  it("emits the raw result envelope for --json", async () => {
    const payload = reactions({ "message-1": [summary()] });
    mocks.callGateway.mockResolvedValueOnce(payload);
    await run({ key: "agent:main:main", json: true });
    expect(runtime.writeJson).toHaveBeenCalledWith(payload, 2);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("renders one line per message with emoji counts", async () => {
    mocks.callGateway.mockResolvedValueOnce(
      reactions({
        "message-1": [summary({ emoji: "👍", count: 2 }), summary({ emoji: "🎉", count: 1 })],
        "message-2": [summary({ emoji: "👀", count: 3 })],
      }),
    );
    await run({ key: "agent:main:main" });
    expect(joinedArgs("log")).toContain("message-1\t👍 ×2  🎉 ×1");
    expect(joinedArgs("log")).toContain("message-2\t👀 ×3");
  });

  it("reports an empty reaction set without failing", async () => {
    mocks.callGateway.mockResolvedValueOnce(reactions({}));
    await run({ key: "agent:main:main" });
    expect(joinedArgs("log")).toContain("No reactions recorded for session agent:main:main.");
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("exits nonzero on a gateway failure", async () => {
    mocks.callGateway.mockRejectedValueOnce(new Error("gateway down"));
    await run({ key: "agent:main:main" });
    expect(joinedArgs("error")).toContain("Failed to list reactions");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("escapes terminal controls in text output", async () => {
    mocks.callGateway.mockResolvedValueOnce(
      reactions({ "message\u0007x": [summary({ emoji: "\u001b[2J" })] }),
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
