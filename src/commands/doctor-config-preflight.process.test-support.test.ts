import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runBuiltRuntime } from "./doctor-config-preflight.process.test-support.js";

const tempDirs = createFixtureLifetime();
afterEach(() => tempDirs.cleanup());

function createRuntime(source: string): string {
  const runtimeRoot = tempDirs.createTempDir("openclaw-doctor-child-diagnostics-");
  fs.mkdirSync(path.join(runtimeRoot, "dist"));
  fs.writeFileSync(path.join(runtimeRoot, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(runtimeRoot, "dist", "entry.js"), source);
  return runtimeRoot;
}

describe("Doctor runtime child diagnostics", () => {
  it("preserves the combined UTF-8 output limit without charging diagnostic readiness", async () => {
    const runtimeRoot = createRuntime('process.stdout.write("éé"); process.stderr.write("xxxx");');
    const env = { PATH: process.env.PATH };
    const result = await tempDirs.track(
      runBuiltRuntime(runtimeRoot, env, [], 5_000, { maxBuffer: 8 }),
    );
    expect(result).toEqual({ code: 0, signal: null, stdout: "éé", stderr: "xxxx" });
    await expect(
      tempDirs.track(runBuiltRuntime(runtimeRoot, env, [], 5_000, { maxBuffer: 7 })),
    ).rejects.toThrow("CLI process exceeded maxBuffer (7 bytes)");
  });
});
