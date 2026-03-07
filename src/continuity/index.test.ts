import { describe, expect, it } from "vitest";
import * as continuity from "./index.js";

describe("continuity barrel exports", () => {
  it("re-exports the runtime continuity surface", () => {
    expect(continuity.CONTINUITY_KIND_ORDER).toEqual([
      "preference",
      "decision",
      "fact",
      "open_loop",
    ]);
    expect(continuity.CONTINUITY_FILE_BY_KIND.preference).toBe("memory/continuity/preferences.md");
    expect(typeof continuity.resolveContinuityConfig).toBe("function");
    expect(typeof continuity.extractContinuityMatches).toBe("function");
    expect(typeof continuity.classifyContinuitySource).toBe("function");
    expect(typeof continuity.isContinuityScopeAllowed).toBe("function");
    expect(typeof continuity.createContinuityService).toBe("function");
    expect(typeof continuity.ContinuityService).toBe("function");
    expect(typeof continuity.ContinuityContextEngine).toBe("function");
    expect(typeof continuity.registerContinuityCli).toBe("function");
  });
});
