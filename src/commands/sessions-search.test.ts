// Sessions search command tests cover param validation, gateway forwarding, and terminal formatting.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionsSearchCommand } from "./sessions-search.js";

const callGatewayCli = vi.hoisted(() => vi.fn());

vi.mock("../cli/gateway-rpc.js", () => ({ callGatewayFromCliWithTransport: callGatewayCli }));

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  };
}

function joinedArgs(mock: { mock: { calls: unknown[][] } }): string {
  return mock.mock.calls.map((call) => String(call[0])).join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sessionsSearchCommand", () => {
  it("rejects a blank query before calling the gateway", async () => {
    const runtime = createRuntime();

    await expect(sessionsSearchCommand({ query: "   " }, runtime)).rejects.toThrow(
      "query must not be blank",
    );

    expect(callGatewayCli).not.toHaveBeenCalled();
  });

  it("rejects --limit outside the gateway bounds (1-25)", async () => {
    const runtime = createRuntime();

    await expect(sessionsSearchCommand({ query: "deploy", limit: 26 }, runtime)).rejects.toThrow(
      "--limit must be between 1 and 25",
    );

    expect(callGatewayCli).not.toHaveBeenCalled();
  });

  it("requires --session keys when --agent is set (gateway scoping rule)", async () => {
    const runtime = createRuntime();

    await expect(
      sessionsSearchCommand({ query: "deploy", agent: "work" }, runtime),
    ).rejects.toThrow("--agent requires at least one --session");

    expect(callGatewayCli).not.toHaveBeenCalled();
  });

  it("rejects blank --session values instead of dropping the filter", async () => {
    const runtime = createRuntime();

    await expect(
      sessionsSearchCommand({ query: "deploy", session: ["", "   "] }, runtime),
    ).rejects.toThrow("--session must not be blank");
    await expect(
      sessionsSearchCommand({ query: "deploy", session: ["agent:main:main", " "] }, runtime),
    ).rejects.toThrow("--session must not be blank");

    expect(callGatewayCli).not.toHaveBeenCalled();
  });

  it("forwards query, limit, agentId, and sessionKeys to sessions.search", async () => {
    callGatewayCli.mockResolvedValue({ results: [] });
    const runtime = createRuntime();

    await sessionsSearchCommand(
      { query: "deploy plan", limit: 5, agent: "work", session: ["agent:work:main"] },
      runtime,
    );

    expect(callGatewayCli).toHaveBeenCalledTimes(1);
    const [method, , params] = callGatewayCli.mock.calls[0]!;
    expect(method).toBe("sessions.search");
    expect(params).toEqual({
      query: "deploy plan",
      limit: 5,
      agentId: "work",
      sessionKeys: ["agent:work:main"],
    });
  });

  it("leaves the timeout unset when --timeout is omitted so the bounded RPC default applies", async () => {
    callGatewayCli.mockResolvedValue({ results: [] });
    const runtime = createRuntime();

    await sessionsSearchCommand({ query: "deploy" }, runtime);

    const [, rpcOpts, , extra] = callGatewayCli.mock.calls[0]!;
    // null (not undefined) disables the request deadline in the transport, which
    // lets a connected-but-silent Gateway stall the command indefinitely.
    expect((rpcOpts as { timeout?: string | null }).timeout).toBeUndefined();
    expect(extra).toMatchObject({ defaultTimeoutMs: 15_000 });
  });

  it("forwards an explicit --timeout override to the transport", async () => {
    callGatewayCli.mockResolvedValue({ results: [] });
    const runtime = createRuntime();

    await sessionsSearchCommand({ query: "deploy", timeout: "2500" }, runtime);

    const [, rpcOpts] = callGatewayCli.mock.calls[0]!;
    expect((rpcOpts as { timeout?: string | null }).timeout).toBe("2500");
  });

  it("prints hits with session key, role, timestamp, score, and snippet", async () => {
    callGatewayCli.mockResolvedValue({
      results: [
        {
          sessionKey: "agent:main:main",
          sessionId: "s-1",
          messageId: "m-9",
          role: "user",
          timestamp: 1757700000000,
          snippet: "we should redeploy the gateway tonight",
          score: 8.25,
        },
      ],
    });
    const runtime = createRuntime();

    await sessionsSearchCommand({ query: "redeploy" }, runtime);

    expect(runtime.exit).not.toHaveBeenCalled();
    const logged = joinedArgs(runtime.log);
    expect(logged).toContain("agent:main:main");
    expect(logged).toContain("user");
    expect(logged).toContain("we should redeploy the gateway tonight");
    expect(logged).toContain("8.25");
    expect(logged).toContain(new Date(1757700000000).toISOString());
  });

  it("reports no matches without exiting non-zero", async () => {
    callGatewayCli.mockResolvedValue({ results: [] });
    const runtime = createRuntime();

    await sessionsSearchCommand({ query: "nothing-here" }, runtime);

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(joinedArgs(runtime.log)).toContain("No matching");
  });

  it("surfaces indexing and archived-exclusion hints", async () => {
    callGatewayCli.mockResolvedValue({
      results: [],
      indexing: true,
      archivedTranscriptsExcluded: 3,
    });
    const runtime = createRuntime();

    await sessionsSearchCommand({ query: "plan" }, runtime);

    const logged = joinedArgs(runtime.log);
    expect(logged).toContain("index");
    expect(logged).toContain("3 archived");
  });

  it("writes the raw gateway result with --json", async () => {
    const result = {
      results: [
        {
          sessionKey: "agent:main:main",
          sessionId: "s-1",
          messageId: "m-1",
          role: "assistant",
          timestamp: 1757700000000,
          snippet: "done",
          score: 1,
        },
      ],
    };
    callGatewayCli.mockResolvedValue(result);
    const runtime = createRuntime();

    await sessionsSearchCommand({ query: "done", json: true }, runtime);

    expect(runtime.writeJson.mock.calls[0]?.[0]).toEqual(result);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("exits non-zero and surfaces the error when the RPC throws", async () => {
    callGatewayCli.mockRejectedValue(new Error("gateway unreachable"));
    const runtime = createRuntime();

    await sessionsSearchCommand({ query: "plan" }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(joinedArgs(runtime.error)).toContain("gateway unreachable");
  });

  it("writes a JSON failure envelope when the RPC throws with --json", async () => {
    callGatewayCli.mockRejectedValue(new Error("gateway unreachable"));
    const runtime = createRuntime();

    await sessionsSearchCommand({ query: "plan", json: true }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.writeJson.mock.calls[0]?.[0]).toMatchObject({
      ok: false,
      error: "gateway unreachable",
    });
  });

  it("sanitizes terminal control characters in snippets and session keys", async () => {
    callGatewayCli.mockResolvedValue({
      results: [
        {
          sessionKey: "agent:main:main",
          sessionId: "s-1",
          messageId: "m-1",
          role: "user",
          timestamp: 1757700000000,
          snippet: "evil \u001b]8;;http://attacker\u0007 text",
          score: 1,
        },
      ],
    });
    const runtime = createRuntime();

    await sessionsSearchCommand({ query: "evil" }, runtime);

    const logged = joinedArgs(runtime.log);
    expect(logged).not.toContain("\u001b");
    expect(logged).toContain("evil");
  });
});
