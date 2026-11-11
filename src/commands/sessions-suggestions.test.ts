// Verify the `sessions suggestions` CLI forwards the canonical suggestion-list
// RPC and keeps empty, JSON, failure, and terminal-safety behavior explicit.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMockCallOutput } from "../cli/test-runtime-capture.js";
import { createNonExitingRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
import { sessionsSuggestionsCommand } from "./sessions-suggestions.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/gateway-rpc.js")>()),
  callGatewayFromCliWithTransport: mocks.callGateway,
}));

function suggestion(overrides: Record<string, unknown> = {}) {
  return {
    id: "suggestion-1",
    sessionKey: "agent:main:main",
    agentId: "main",
    author: { type: "human", id: "user-1", label: "Ada" },
    text: "Summarize the failing test",
    createdAt: 1_700_000_000_000,
    state: "pending",
    ...overrides,
  };
}

function suggestions(rows: Array<Record<string, unknown>>) {
  return { suggestions: rows, role: "owner" };
}

describe("sessionsSuggestionsCommand", () => {
  let runtime: ReturnType<typeof createNonExitingRuntimeEnv>;

  const run = (opts: Parameters<typeof sessionsSuggestionsCommand>[0]) =>
    sessionsSuggestionsCommand(opts, runtime);
  const joinedArgs = (channel: "log" | "error") => getMockCallOutput(vi.mocked(runtime[channel]));

  beforeEach(() => {
    mocks.callGateway.mockReset();
    runtime = createNonExitingRuntimeEnv();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("forwards sessionKey and agentId through the canonical RPC", async () => {
    mocks.callGateway.mockResolvedValueOnce(suggestions([]));
    await run({ key: "agent:work:main", agent: "work" });
    expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith(
      "session.suggestions.list",
      expect.any(Object),
      { sessionKey: "agent:work:main", agentId: "work" },
      { defaultTimeoutMs: 30_000, sharedStateMode: "read-only" },
    );
  });

  it("omits agentId and leaves the timeout unset when unspecified", async () => {
    mocks.callGateway.mockResolvedValueOnce(suggestions([]));
    await run({ key: "agent:main:main" });
    const [, rpcOpts, params] = expectDefined(
      mocks.callGateway.mock.calls[0],
      "suggestions RPC call",
    );
    expect(params).toEqual({ sessionKey: "agent:main:main" });
    expect(rpcOpts).not.toHaveProperty("timeout");
  });

  it("emits the raw result envelope for --json", async () => {
    const payload = suggestions([suggestion()]);
    mocks.callGateway.mockResolvedValueOnce(payload);
    await run({ key: "agent:main:main", json: true });
    expect(runtime.writeJson).toHaveBeenCalledWith(payload, 2);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("renders one line per suggestion with state and author", async () => {
    mocks.callGateway.mockResolvedValueOnce(
      suggestions([
        suggestion({ id: "suggestion-1", state: "pending", text: "Summarize the failing test" }),
        suggestion({
          id: "suggestion-2",
          state: "dismissed",
          author: { type: "human", id: "user-2", label: "Grace" },
          text: "Queue the release notes",
        }),
      ]),
    );
    await run({ key: "agent:main:main" });
    const output = joinedArgs("log");
    expect(output).toContain("suggestion-1\tpending\tAda\t");
    expect(output).toContain("Summarize the failing test");
    expect(output).toContain("suggestion-2\tdismissed\tGrace\t");
  });

  it("reports an empty suggestion set without failing", async () => {
    mocks.callGateway.mockResolvedValueOnce(suggestions([]));
    await run({ key: "agent:main:main" });
    expect(joinedArgs("log")).toContain("No suggestions recorded for session agent:main:main.");
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("exits nonzero on a gateway failure", async () => {
    mocks.callGateway.mockRejectedValueOnce(new Error("gateway down"));
    await run({ key: "agent:main:main" });
    expect(joinedArgs("error")).toContain("Failed to list session suggestions");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("escapes terminal controls in text output", async () => {
    mocks.callGateway.mockResolvedValueOnce(
      suggestions([suggestion({ id: "id\u0007x", text: "line\u001b[2Jbreak" })]),
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
