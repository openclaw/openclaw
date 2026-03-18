import { describe, expect, it } from "vitest";
import type { ConfigSource, ConfigSourceKind } from "./types.js";

describe("ConfigSource types", () => {
  it("ConfigSourceKind is file | nacos", () => {
    const k: ConfigSourceKind = "file";
    expect(k).toBe("file");
    const n: ConfigSourceKind = "nacos";
    expect(n).toBe("nacos");
  });

  it("ConfigSource has readSnapshot and optional subscribe", () => {
    const source: ConfigSource = {
      kind: "file",
      readSnapshot: async () => ({} as never),
    };
    expect(source.kind).toBe("file");
    expect(typeof source.readSnapshot).toBe("function");
  });
});
