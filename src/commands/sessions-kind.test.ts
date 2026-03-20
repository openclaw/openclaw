import { describe, expect, it, vi } from "vitest";
import { resolveSessionKinds } from "./sessions-kind.js";

function createRuntime() {
  const errors: string[] = [];
  return {
    runtime: {
      log: vi.fn(),
      error: (msg: unknown) => errors.push(String(msg)),
      exit: (code: number) => {
        throw new Error(`exit ${code}`);
      },
    },
    errors,
  };
}

describe("resolveSessionKinds", () => {
  it("returns null when no filter is provided", () => {
    const { runtime } = createRuntime();
    expect(resolveSessionKinds(undefined, runtime)).toBeNull();
  });

  it("accepts repeated and comma-separated values", () => {
    const { runtime } = createRuntime();
    expect(Array.from(resolveSessionKinds(["group, global", "direct"], runtime) ?? [])).toEqual([
      "group",
      "global",
      "direct",
    ]);
  });

  it("rejects invalid kinds", () => {
    const { runtime, errors } = createRuntime();
    expect(() => resolveSessionKinds(["weird"], runtime)).toThrow("exit 1");
    expect(errors[0]).toContain("--kind must be one of: direct, group, global, unknown");
  });

  it("rejects empty filter entries", () => {
    const { runtime, errors } = createRuntime();
    expect(() => resolveSessionKinds([",  ,"], runtime)).toThrow("exit 1");
    expect(errors[0]).toContain(
      "--kind must include at least one value: direct, group, global, unknown",
    );
  });
});
