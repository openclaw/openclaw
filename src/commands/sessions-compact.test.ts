import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { createNonExitingRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
import { sessionsCompactCommand } from "./sessions-compact.js";

const callGatewayCli = vi.hoisted(() => vi.fn());
const runtime = createNonExitingRuntimeEnv();

vi.mock("../cli/gateway-rpc.js", () => ({ callGatewayFromCliWithTransport: callGatewayCli }));

function joinedArgs(mock: RuntimeEnv["log"]): string {
  return vi
    .mocked(mock)
    .mock.calls.map((call) => String(call[0]))
    .join("\n");
}

function compact(opts: Parameters<typeof sessionsCompactCommand>[0] = { key: "agent:main:main" }) {
  return sessionsCompactCommand(opts, runtime);
}

beforeEach(() => vi.clearAllMocks());

describe("sessionsCompactCommand", () => {
  it.each(["compacted", "pending", "noop", "failed", "throw"])(
    "escapes terminal controls in %s output without changing RPC input",
    async (outcome) => {
      const key = "agent:main:notes\u001b[2J\nnext";
      const reason = "detail\u001b]2;changed\u0007\rnext";
      if (outcome === "throw") {
        callGatewayCli.mockRejectedValue(new Error(reason));
      } else {
        callGatewayCli.mockResolvedValue({
          ok: outcome !== "failed",
          key,
          compacted: outcome === "compacted",
          reason,
          result: { details: { pending: outcome === "pending" } },
        });
      }
      await compact({ key });
      expect(callGatewayCli.mock.calls[0]?.[2]).toEqual({ key });
      const output = `${joinedArgs(runtime.log)}${joinedArgs(runtime.error)}`;
      for (const control of ["\u0007", "\u001b", "\r", "\n"]) {
        expect(output).not.toContain(control);
      }
      if (outcome !== "throw") {
        expect(output).toContain("agent:main:notes\\nnext");
      }
      if (["noop", "failed", "throw"].includes(outcome)) {
        expect(output).toContain("detail\\rnext");
      }
      if (["failed", "throw"].includes(outcome)) {
        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(joinedArgs(runtime.error)).toContain("Compaction failed");
      }
      if (outcome === "pending") {
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(output).toContain("pending");
        expect(output).not.toContain("No compaction needed");
      }
    },
  );

  it("preserves raw result values in JSON output", async () => {
    const payload = {
      ok: false,
      key: "agent:main:notes\u001b[2J\nnext",
      reason: "detail\u001b]2;changed\u0007\rnext",
    };
    callGatewayCli.mockResolvedValue(payload);
    await compact({ key: payload.key, json: true });
    expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(payload, 2);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects a blank agent before calling the Gateway", async () => {
    await expect(
      sessionsCompactCommand({ key: "agent:main:main", agent: "" }, runtime),
    ).rejects.toThrow("--agent must not be blank");

    expect(callGatewayCli).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "prints successful compaction and its degradation warning (%s)",
    async (qualityDegraded) => {
      callGatewayCli.mockResolvedValue({
        ok: true,
        key: "agent:main:main",
        compacted: true,
        result: { tokensBefore: 243868, tokensAfter: 34941, details: { qualityDegraded } },
      });
      await compact();
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(callGatewayCli.mock.calls[0]?.[1]).toMatchObject({ timeout: null });
      const logged = joinedArgs(runtime.log);
      expect(logged).toContain("243868");
      expect(logged).toContain("34941");
      expect(logged.includes("degraded summary")).toBe(qualityDegraded);
      if (qualityDegraded) {
        expect(logged).toContain("Older details, exact identifiers, or pending requests");
        expect(logged).toContain("/new or a larger model");
      }
    },
  );

  it("exits non-zero when the gateway response omits explicit success", async () => {
    callGatewayCli.mockResolvedValue({ key: "agent:main:main", compacted: false });
    await compact();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(joinedArgs(runtime.error)).toContain("Compaction failed");
  });

  it("forwards agentId and maxLines to the RPC params", async () => {
    callGatewayCli.mockResolvedValue({
      ok: true,
      key: "agent:work:main",
      compacted: true,
      kept: 200,
    });
    await compact({ key: "agent:work:main", agent: "work", maxLines: 200 });
    expect(callGatewayCli).toHaveBeenCalledExactlyOnceWith(
      "sessions.compact",
      expect.anything(),
      { key: "agent:work:main", agentId: "work", maxLines: 200 },
      expect.anything(),
    );
  });
});
