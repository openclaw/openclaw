import { afterEach, describe, expect, it, vi } from "vitest";
import * as pinnedBun from "../../scripts/lib/pinned-bun.mts";
import { resolveTestRuntime } from "../../scripts/lib/test-runtime.mts";

afterEach(() => vi.restoreAllMocks());

describe("test runtime policy", () => {
  it.each(["node", "bun"] as const)("honors explicit %s without probing Bun", (runtime) => {
    const resolve = vi.spyOn(pinnedBun, "resolvePinnedBun");
    expect(resolveTestRuntime({ OPENCLAW_VITEST_RUNTIME: ` ${runtime} `, CI: "1" })).toBe(runtime);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects invalid explicit runtimes", () => {
    expect(() => resolveTestRuntime({ OPENCLAW_VITEST_RUNTIME: "deno" })).toThrow(
      "expected node or bun",
    );
  });

  it.each(["1", "true", "custom", "0"])("keeps CI=%s on Node without staging", (CI) => {
    const resolve = vi.spyOn(pinnedBun, "resolvePinnedBun");
    expect(resolveTestRuntime({ CI })).toBe("node");
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "false"])("defaults local CI=%s to the available fork", (CI) => {
    vi.spyOn(pinnedBun, "resolvePinnedBun").mockReturnValue({ command: "/cache/bin/bun" });
    expect(resolveTestRuntime({ CI })).toBe("bun");
  });

  it("falls back to Node with one actionable notice per process", () => {
    vi.spyOn(pinnedBun, "resolvePinnedBun").mockReturnValue({ reason: "offline" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveTestRuntime({})).toBe("node");
    expect(resolveTestRuntime({})).toBe("node");
    expect(error).toHaveBeenCalledExactlyOnceWith(
      "[openclaw] Bun fork unavailable (offline); using Node. Set OPENCLAW_VITEST_RUNTIME=node to silence.",
    );
  });
});
