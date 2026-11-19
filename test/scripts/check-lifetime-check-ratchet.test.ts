import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { countLifetimeChecks, main } from "../../scripts/check-lifetime-check-ratchet.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("counts calls and refusal literals, not comments, declarations or references", () => {
  using parser = createNativeTypeScriptParser();
  const source = parser.parseSourceFile(
    "fixture.ts",
    [
      "// captureHttpRequestAuthority(); authority changed",
      "function captureHttpRequestAuthority() {}",
      "const reference = captureHttpRequestAuthority;",
      "captureHttpRequestAuthority(); owner.captureHttpRequestAuthority();",
      'owner["captureHttpRequestAuthority"]();',
      'const refusal = "AUTHORITY CHANGED and no longer current";',
      "const template = `caller ${name} authority is no longer active`;",
      'const unrelated = "safe"; const fence = "pending question is no longer current";',
    ].join("\n"),
  );
  expect(countLifetimeChecks(source)).toBe(5);
});

it("rejects a per-file gain even when another file loses one, and accepts reductions and verified renames", () => {
  const root = tempDirs.make("openclaw-lifetime-ratchet-");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: "pipe" },
    ).trim();
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const call = "captureHttpRequestAuthority();\n";
  git("init", "-q");
  write("src/a.ts", call);
  write("src/b.ts", call.repeat(2));
  git("add", ".");
  git("commit", "-qm", "fixture");
  const base = git("rev-parse", "HEAD");
  const args = ["--base", base];
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  write("src/a.ts", call.repeat(2));
  write("src/b.ts", call);
  expect(main(root, args)).toBe(1);
  expect(error.mock.calls.flat().join("\n")).toContain("src/a.ts: 1 -> 2 (+1)");
  expect(error.mock.calls.flat().join("\n")).toContain(
    "authority is checked once when a request starts",
  );
  write("src/a.ts", "");
  expect(main(root, args)).toBe(0);
  write("src/a.ts", call);
  git("mv", "src/a.ts", "src/renamed.ts");
  expect(main(root, args)).toBe(0);
  write("src/renamed.ts", call.repeat(2));
  expect(main(root, args)).toBe(1);
  write("src/renamed.ts", call);
  write("src/ignored.test.ts", call.repeat(3));
  expect(main(root, [...args, "--full-tree"])).toBe(0);
  git("add", ".");
  expect(main(root, [...args, "--staged"])).toBe(0);
});
