import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { getCliProcessTestTimeout } from "../cli/cli-process-child.test-helpers.js";
import { runBuiltRuntime } from "./doctor-config-preflight.process.test-support.js";

const tempDirs = createFixtureLifetime();
afterEach(() => tempDirs.cleanup());
const DIAGNOSTIC_CHILD_TIMEOUT_MS = 1_000;

function createRuntime(source: string): string {
  const runtimeRoot = tempDirs.createTempDir("openclaw-doctor-child-diagnostics-");
  fs.mkdirSync(path.join(runtimeRoot, "dist"));
  fs.writeFileSync(path.join(runtimeRoot, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(runtimeRoot, "dist", "entry.js"), source);
  return runtimeRoot;
}

describe("Doctor runtime child diagnostics", () => {
  it("preserves normal output, command arguments, exit status, and caller runtime policy", async () => {
    const runtimeRoot = createRuntime(`
      console.log(JSON.stringify({
        args: process.argv.slice(2),
        maglevDisabled: process.execArgv.includes("--no-maglev"),
        symlinksPreserved: process.execArgv.includes("--preserve-symlinks"),
        cwd: process.cwd(),
      }));
      console.error("validation diagnostic");
      process.exitCode = 7;
    `);
    const result = await tempDirs.track(
      runBuiltRuntime(
        runtimeRoot,
        { PATH: process.env.PATH },
        ["config", "validate", "--json"],
        5_000,
      ),
    );

    expect(result).toEqual({
      code: 7,
      signal: null,
      stdout: `${JSON.stringify({
        args: ["config", "validate", "--json"],
        maglevDisabled: false,
        symlinksPreserved: true,
        cwd: runtimeRoot,
      })}\n`,
      stderr: "validation diagnostic\n",
    });
  });

  it("preserves the combined UTF-8 output limit without charging diagnostic readiness", async () => {
    const runtimeRoot = createRuntime('process.stdout.write("éé"); process.stderr.write("xxxx");');
    const env = { PATH: process.env.PATH };
    const result = await tempDirs.track(runBuiltRuntime(runtimeRoot, env, [], 5_000, 8));
    expect(result).toEqual({ code: 0, signal: null, stdout: "éé", stderr: "xxxx" });
    await expect(tempDirs.track(runBuiltRuntime(runtimeRoot, env, [], 5_000, 7))).rejects.toThrow(
      "CLI process exceeded maxBuffer (7 bytes)",
    );
  });

  it.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
    "reports the retained timer after a built child prints its final output",
    async () => {
      const runtimeRoot = createRuntime(
        'console.log("validation finished"); setInterval(() => {}, 1_000);',
      );
      const failure = await Promise.resolve()
        .then(() =>
          tempDirs.track(
            runBuiltRuntime(
              runtimeRoot,
              { PATH: process.env.PATH },
              [],
              DIAGNOSTIC_CHILD_TIMEOUT_MS,
            ),
          ),
        )
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const message = String(failure);
      expect(message).toContain("1000ms deadlock guard");
      expect(message).toContain("validation finished");
      expect(message).toContain('"Timeout":1');
      expect(message).toContain('"activeHandles"');
      const report = message
        .split("--- Node diagnostic report ---\n")[1]
        ?.split("\n--- child diagnostics ---")[0];
      expect(JSON.parse(report ?? "null")).toMatchObject({
        libuv: expect.arrayContaining([
          expect.objectContaining({ type: "timer", is_active: true, is_referenced: true }),
        ]),
      });
    },
    getCliProcessTestTimeout(DIAGNOSTIC_CHILD_TIMEOUT_MS),
  );
});
