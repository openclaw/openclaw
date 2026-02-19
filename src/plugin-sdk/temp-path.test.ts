import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRandomTempFilePath } from "./temp-path.js";

describe("buildRandomTempFilePath", () => {
  it("builds deterministic paths when now/uuid are provided", () => {
    const result = buildRandomTempFilePath({
      prefix: "line-media",
      extension: ".jpg",
      tmpDir: "/tmp",
      now: 123,
      uuid: "abc",
    });
    expect(result).toBe(path.join("/tmp", "line-media-123-abc.jpg"));
  });

  it("sanitizes prefix and extension to avoid path traversal segments", () => {
    const result = buildRandomTempFilePath({
      prefix: "../../line/../media",
      extension: "/../.jpg",
      now: 123,
      uuid: "abc",
    });
    const tmpRoot = path.resolve(os.tmpdir());
    const resolved = path.resolve(result);
    const rel = path.relative(tmpRoot, resolved);
    expect(rel === ".." || rel.startsWith(`..${path.sep}`)).toBe(false);
    expect(path.basename(result)).toBe("line-media-123-abc.jpg");
    expect(result).not.toContain("..");
  });
});
