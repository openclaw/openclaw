import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "./helpers/temp-dir.js";

async function makeRunCliLauncherFixture(fixtureRoots: string[]): Promise<string> {
  const fixtureRoot = makeTempDir(fixtureRoots, "openclaw-runcli-launcher-");
  await fs.mkdir(path.join(fixtureRoot, "scripts"), { recursive: true });
  await fs.copyFile(
    path.resolve(process.cwd(), "scripts", "openclaw-runcli-launcher.mjs"),
    path.join(fixtureRoot, "scripts", "openclaw-runcli-launcher.mjs"),
  );
  await fs.mkdir(path.join(fixtureRoot, "dist"), { recursive: true });
  return fixtureRoot;
}

describe("openclaw runCli launcher", () => {
  const fixtureRoots: string[] = [];

  afterEach(async () => {
    cleanupTempDirs(fixtureRoots);
  });

  it("forces process exit after runCli resolves even when active handles remain", async () => {
    const fixtureRoot = await makeRunCliLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "run-main-fixture.js"),
      `export async function runCli(argv) {
  setInterval(() => {}, 1_000);
  process.exitCode = 0;
  process.stdout.write(\`stub runCli \${argv.slice(2).join(" ")}\\n\`);
}
`,
      "utf8",
    );

    const launcherPath = path.join(fixtureRoot, "scripts", "openclaw-runcli-launcher.mjs");
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [launcherPath, "memory-pro", "version"], {
      cwd: fixtureRoot,
      encoding: "utf8",
      timeout: 1_500,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stub runCli memory-pro version");
    expect(elapsedMs).toBeLessThan(1_500);
  });
});
