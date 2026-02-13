import { describe, expect, it } from "vitest";
import { rewriteUpdateFlagArgv } from "./run-main.js";

describe("rewriteUpdateFlagArgv", () => {
  it("leaves argv unchanged when --update is absent", () => {
    const argv = ["node", "entry.js", "status"];
    expect(rewriteUpdateFlagArgv(argv)).toBe(argv);
  });

  it("rewrites --update into the update command", () => {
    expect(rewriteUpdateFlagArgv(["node", "entry.js", "--update"])).toEqual([
      "node",
      "entry.js",
      "update",
    ]);
  });

  it("preserves global flags that appear before --update", () => {
    expect(rewriteUpdateFlagArgv(["node", "entry.js", "--profile", "p", "--update"])).toEqual([
      "node",
      "entry.js",
      "--profile",
      "p",
      "update",
    ]);
  });

  it("keeps update options after the rewritten command", () => {
    expect(rewriteUpdateFlagArgv(["node", "entry.js", "--update", "--json"])).toEqual([
      "node",
      "entry.js",
      "update",
      "--json",
    ]);
  });
});

describe("runCli process.exit on success", () => {
  it("source code calls process.exit(0) after parseAsync and tryRouteCli", async () => {
    // Verify the fix is present in the source by checking that process.exit(0)
    // is called in both success paths. We read the source directly to avoid
    // the complexity of mocking all CLI dependencies.
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("./run-main.ts", import.meta.url).pathname.replace(/\.ts$/, ".ts"),
      "utf-8",
    );

    // After tryRouteCli returns true, process.exit(0) should be called
    expect(source).toMatch(/tryRouteCli\(.*\)\)\s*\{[\s\S]*?process\.exit\(0\)/);

    // After program.parseAsync completes, process.exit(0) should be called
    expect(source).toMatch(/parseAsync\(.*\);[\s\S]*?process\.exit\(0\)/);
  });
});
