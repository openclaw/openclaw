import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBackupArchivePath, resolveRequiredBackupPath } from "./backup-shared.js";

afterEach(() => vi.unstubAllEnvs());

describe.each([
  ["repository", resolveRequiredBackupPath, false],
  ["archive", resolveBackupArchivePath, true],
] as const)("%s paths", (_kind, resolve, literal) => {
  it.each([undefined, "", " \t "])("rejects blank values: %j", (value) => {
    expect(() => resolve(value, "--target")).toThrow("Missing required --target value.");
  });

  it.each(["  backups/archive  ", path.resolve("archive output ")])(
    "resolves relative and absolute paths: %j",
    (value) => {
      expect(resolve(value, "--target")).toBe(path.resolve(literal ? value : value.trim()));
    },
  );

  it("expands tilde from the effective home", () => {
    const home = path.resolve("effective-home");
    vi.stubEnv("OPENCLAW_HOME", home);
    expect(resolve("~/backups ", "--target")).toBe(
      path.join(home, literal ? "backups " : "backups"),
    );
  });
});
