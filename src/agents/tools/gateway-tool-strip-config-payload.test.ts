import { describe, expect, it } from "vitest";
import { stripConfigWriteResultPayloadForTest as strip } from "./gateway-tool.js";

// Regression coverage for #47610: the agent-facing `gateway` tool wraps the
// Gateway RPC `config.patch`/`config.apply` results, and the redacted full
// config that those RPCs return for direct callers must not be forwarded into
// the agent transcript.
describe("stripConfigWriteResultPayload", () => {
  it("removes the `config` field from a typical config.patch/config.apply success result", () => {
    const result = {
      ok: true,
      path: "/tmp/openclaw.json",
      config: { agents: { defaults: { thinkingDefault: "high" } } },
      restart: { ok: true },
      sentinel: { path: "/tmp/restart", payload: { reason: "config.patch" } },
    };

    const stripped = strip(result) as Record<string, unknown>;

    expect(stripped).not.toHaveProperty("config");
    expect(stripped).toMatchObject({
      ok: true,
      path: "/tmp/openclaw.json",
      restart: { ok: true },
      sentinel: { path: "/tmp/restart", payload: { reason: "config.patch" } },
    });
  });

  it("preserves a noop config.patch result while still dropping the redacted config", () => {
    const result = {
      ok: true,
      noop: true,
      path: "/tmp/openclaw.json",
      config: { agents: { defaults: { thinkingDefault: "high" } } },
    };

    expect(strip(result)).toEqual({
      ok: true,
      noop: true,
      path: "/tmp/openclaw.json",
    });
  });

  it("returns results without a `config` field unchanged", () => {
    const result = { ok: true, restart: { ok: true } };
    expect(strip(result)).toBe(result);
  });

  it("passes through non-object results (null, undefined, strings, arrays)", () => {
    expect(strip(null)).toBeNull();
    expect(strip(undefined)).toBeUndefined();
    expect(strip("error")).toBe("error");
    const arr: unknown[] = [{ config: { dropped: true } }];
    expect(strip(arr)).toBe(arr);
  });

  it("does not deep-strip nested `config` keys, only the top-level field", () => {
    const result = {
      ok: true,
      restart: { ok: true, config: "inner-untouched" },
    };
    expect(strip(result)).toEqual({
      ok: true,
      restart: { ok: true, config: "inner-untouched" },
    });
  });
});
