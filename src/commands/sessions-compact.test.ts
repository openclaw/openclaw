// Sessions compact command tests cover non-zero exits on failure and param forwarding.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { createNonExitingRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
import { sessionsCompactCommand } from "./sessions-compact.js";

const callGatewayCli = vi.hoisted(() => vi.fn());

vi.mock("../cli/gateway-rpc.js", () => ({ callGatewayFromCliWithTransport: callGatewayCli }));

function joinedArgs(mock: RuntimeEnv["log"]): string {
  return vi
    .mocked(mock)
    .mock.calls.map((call) => String(call[0]))
    .join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
});

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
      const runtime = createNonExitingRuntimeEnv();

      await sessionsCompactCommand({ key }, runtime);

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
    },
  );

  it("preserves raw result values in JSON output", async () => {
    const payload = {
      ok: false,
      key: "agent:main:notes\u001b[2J\nnext",
      reason: "detail\u001b]2;changed\u0007\rnext",
    };
    callGatewayCli.mockResolvedValue(payload);
    const runtime = createNonExitingRuntimeEnv();

    await sessionsCompactCommand({ key: payload.key, json: true }, runtime);

    expect(runtime.writeJson).toHaveBeenCalledWith(payload, 2);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects a blank agent before calling the Gateway", async () => {
    const runtime = createNonExitingRuntimeEnv();

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
      const runtime = createNonExitingRuntimeEnv();

      await sessionsCompactCommand({ key: "agent:main:main" }, runtime);

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

  it("reports an asynchronously started Codex compaction as pending, not a no-op", async () => {
    callGatewayCli.mockResolvedValue({
      ok: true,
      key: "agent:main:main",
      compacted: false,
      result: {
        tokensBefore: 1200,
        details: { backend: "codex-app-server", signal: "thread/compact/start", pending: true },
      },
    });
    const runtime = createNonExitingRuntimeEnv();

    await sessionsCompactCommand({ key: "agent:main:main" }, runtime);

    expect(runtime.exit).not.toHaveBeenCalled();
    const logged = joinedArgs(runtime.log);
    expect(logged).toContain("pending");
    expect(logged).not.toContain("No compaction needed");
  });

  it("exits non-zero when the gateway reports ok:false (no silent no-op)", async () => {
    callGatewayCli.mockResolvedValue({
      ok: false,
      key: "agent:main:main",
      compacted: false,
      reason: "summarize interrupted",
    });
    const runtime = createNonExitingRuntimeEnv();

    await sessionsCompactCommand({ key: "agent:main:main" }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(joinedArgs(runtime.error)).toContain("summarize interrupted");
  });

  it("exits non-zero when the gateway response omits explicit success", async () => {
    callGatewayCli.mockResolvedValue({ key: "agent:main:main", compacted: false });
    const runtime = createNonExitingRuntimeEnv();

    await sessionsCompactCommand({ key: "agent:main:main" }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(joinedArgs(runtime.error)).toContain("Compaction failed");
  });

  it("exits non-zero and surfaces the error when the RPC throws", async () => {
    callGatewayCli.mockRejectedValue(new Error("gateway unreachable"));
    const runtime = createNonExitingRuntimeEnv();

    await sessionsCompactCommand({ key: "agent:main:main" }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(joinedArgs(runtime.error)).toContain("gateway unreachable");
  });

  it("emits the payload and still exits non-zero in JSON mode when ok:false", async () => {
    const payload = {
      ok: false,
      key: "agent:main:main",
      compacted: false,
      reason: "summarize interrupted",
    };
    callGatewayCli.mockResolvedValue(payload);
    const runtime = createNonExitingRuntimeEnv();

    await sessionsCompactCommand({ key: "agent:main:main", json: true }, runtime);

    expect(runtime.writeJson).toHaveBeenCalledTimes(1);
    expect(
      expectDefined(
        vi.mocked(runtime.writeJson).mock.calls[0],
        "runtime.writeJson.mock.calls[0] test invariant",
      )[0],
    ).toEqual(payload);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("forwards agentId and maxLines to the RPC params", async () => {
    callGatewayCli.mockResolvedValue({
      ok: true,
      key: "agent:work:main",
      compacted: true,
      kept: 200,
    });
    const runtime = createNonExitingRuntimeEnv();

    await sessionsCompactCommand({ key: "agent:work:main", agent: "work", maxLines: 200 }, runtime);

    expect(callGatewayCli).toHaveBeenCalledTimes(1);
    const [method, , params] = expectDefined(
      callGatewayCli.mock.calls[0],
      "callGatewayCli.mock.calls[0] test invariant",
    );
    expect(method).toBe("sessions.compact");
    expect(params).toEqual({ key: "agent:work:main", agentId: "work", maxLines: 200 });
  });
});
