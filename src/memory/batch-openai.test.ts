import { describe, expect, it } from "vitest";
import { sanitizeCustomId } from "./batch-openai.js";

describe("sanitizeCustomId", () => {
  it("returns valid ids unchanged", () => {
    expect(sanitizeCustomId("abc123")).toBe("abc123");
    expect(sanitizeCustomId("ABC_xyz-123")).toBe("ABC_xyz-123");
  });

  it("replaces dots with underscores", () => {
    expect(sanitizeCustomId("2026-01-25.md")).toBe("2026-01-25_md");
  });

  it("replaces colons with underscores", () => {
    expect(sanitizeCustomId("path:to:file")).toBe("path_to_file");
  });

  it("replaces multiple invalid characters", () => {
    expect(sanitizeCustomId("memory:2026-01-25.md:10:20")).toBe("memory_2026-01-25_md_10_20");
  });

  it("handles sha256 hex hashes unchanged", () => {
    const hash = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    expect(sanitizeCustomId(hash)).toBe(hash);
  });
});
