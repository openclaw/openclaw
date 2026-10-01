import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-database-worker-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("rejects total T1 growth with call sites and allows splits, shrinkage, and worker calls", () => {
  const root = tempDirs.make("openclaw-sqlite-ratchet-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  fs.mkdirSync(path.join(root, "src"));
  const file = path.join(root, "src/runtime.ts");
  const source = "executeSqliteQuerySync(query);\n";
  fs.writeFileSync(file, source.repeat(2));
  git("init");
  git("add", ".");
  git("commit", "-m", "base");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  expect(main(root, ["--base", "HEAD", "--staged"])).toBe(0);
  fs.writeFileSync(file, source.repeat(3));
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining("src/runtime.ts: 2 -> 3"));
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("src/runtime.ts:3:1 executeSqliteQuerySync"),
  );
  git("add", ".");
  fs.writeFileSync(file, source);
  errors.mockClear();
  expect(main(root, ["--base", "HEAD", "--staged"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining("src/runtime.ts: 2 -> 3"));
  fs.writeFileSync(path.join(root, "src/runtime.worker.ts"), source.repeat(3));
  errors.mockClear();
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  fs.writeFileSync(file, "export {};\n");
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  expect(errors).not.toHaveBeenCalled();
  fs.writeFileSync(file, source);
  fs.writeFileSync(path.join(root, "src/split.ts"), source);
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  fs.writeFileSync(path.join(root, "src/split.ts"), source.repeat(2));
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("src/split.ts:2:1 executeSqliteQuerySync"),
  );
});
