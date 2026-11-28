import { describe, expect, it } from "vitest";
import { createStableCronManagementDeclaration } from "./cron-tool-stable-management.js";

describe("stable cron management declaration", () => {
  it("reuses the last granted declaration for a session's ungranted turns", () => {
    const stable = createStableCronManagementDeclaration();
    expect(stable.resolve("agent:main:main", undefined)).toBeUndefined();
    expect(stable.resolve("agent:main:main", "also")).toBe("also");
    expect(stable.resolve("agent:main:main", undefined)).toBe("also");
    expect(stable.resolve("agent:main:other", undefined)).toBeUndefined();
    expect(stable.resolve("agent:main:other", "only")).toBe("only");
    expect(stable.resolve("agent:main:other", undefined)).toBeUndefined();
  });

  it("keeps a wider declaration through management-only continuations", () => {
    const stable = createStableCronManagementDeclaration();
    expect(stable.resolve("agent:main:main", "also")).toBe("also");
    expect(stable.resolve("agent:main:main", "only")).toBe("also");
    expect(stable.resolve("agent:main:main", undefined)).toBe("also");
    expect(stable.resolve("agent:main:only", "only")).toBe("only");
    expect(stable.resolve("agent:main:only", "also")).toBe("also");
    expect(stable.resolve("agent:main:only", "only")).toBe("also");
  });

  it("does not remember turns without a session", () => {
    const stable = createStableCronManagementDeclaration();
    expect(stable.resolve(undefined, "also")).toBe("also");
    expect(stable.resolve(" ", undefined)).toBeUndefined();
  });

  it("forgets the oldest sessions beyond its bound", () => {
    const stable = createStableCronManagementDeclaration();
    for (let i = 0; i <= 512; i += 1) {
      stable.resolve(`agent:main:s${i}`, "also");
    }
    expect(stable.resolve("agent:main:s0", undefined)).toBeUndefined();
    expect(stable.resolve("agent:main:s512", undefined)).toBe("also");
  });
});
