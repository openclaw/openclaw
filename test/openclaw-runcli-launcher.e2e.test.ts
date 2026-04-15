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

async function writeMemoryProCliFixture(fixtureRoot: string): Promise<void> {
  const stateDir = path.join(fixtureRoot, ".openclaw");
  const pluginDir = path.join(fixtureRoot, "plugins", "memory-lancedb-pro");
  const pluginFile = path.join(pluginDir, "index.cjs");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify(
      {
        plugins: {
          enabled: true,
          load: { paths: [pluginFile] },
          allow: ["memory-lancedb-pro"],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: "memory-lancedb-pro",
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        commandAliases: [{ name: "memory-pro" }],
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    pluginFile,
    `function leakHandle() {
  setInterval(() => {}, 1_000);
}

module.exports = {
  id: "memory-lancedb-pro",
  register(api) {
    api.registerCli(
      ({ program }) => {
        const memoryPro = program.command("memory-pro").description("Memory Pro");
        memoryPro
          .command("version")
          .description("Print plugin version")
          .action(() => {
            leakHandle();
            process.stdout.write("1.1.0-test\\n");
          });
        memoryPro
          .command("stats")
          .description("Print stats")
          .option("--json")
          .action((options) => {
            leakHandle();
            const payload = {
              retrieval: {
                mode: "hybrid",
                fts: { available: true, lastError: null },
              },
            };
            process.stdout.write(options.json ? JSON.stringify(payload) + "\\n" : "stats\\n");
          });
      },
      {
        commands: ["memory-pro"],
        descriptors: [
          {
            name: "memory-pro",
            description: "Memory Pro",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
};
`,
    "utf8",
  );
}

function extractProfiledPlugins(text: string): string[] {
  return [...text.matchAll(/^\[plugin-load-profile\] phase=[^\s]+ plugin=([^\s]+)\s/mg)].map(
    (match) => match[1],
  );
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

  it("executes the real memory-pro version command path and exits despite active plugin handles", async () => {
    const fixtureRoot = await makeRunCliLauncherFixture(fixtureRoots);
    await writeMemoryProCliFixture(fixtureRoot);

    const launcherPath = path.resolve(process.cwd(), "scripts", "openclaw-runcli-launcher.mjs");
    const env = {
      ...process.env,
      HOME: fixtureRoot,
      USERPROFILE: fixtureRoot,
      OPENCLAW_STATE_DIR: path.join(fixtureRoot, ".openclaw"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(fixtureRoot, "no-bundled-plugins"),
      OPENCLAW_PLUGIN_LOAD_PROFILE: "1",
      OPENCLAW_TEST_FAST: "1",
    };
    delete env.VITEST;

    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [launcherPath, "memory-pro", "version"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      timeout: 1_500,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1.1.0-test");
    expect(elapsedMs).toBeLessThan(1_500);
    expect([...new Set(extractProfiledPlugins(`${result.stderr}\n${result.stdout}`))]).toEqual([
      "memory-lancedb-pro",
    ]);
  });

  it("keeps memory-pro stats --json parseable and short-lived on the real command path", async () => {
    const fixtureRoot = await makeRunCliLauncherFixture(fixtureRoots);
    await writeMemoryProCliFixture(fixtureRoot);

    const launcherPath = path.resolve(process.cwd(), "scripts", "openclaw-runcli-launcher.mjs");
    const env = {
      ...process.env,
      HOME: fixtureRoot,
      USERPROFILE: fixtureRoot,
      OPENCLAW_STATE_DIR: path.join(fixtureRoot, ".openclaw"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(fixtureRoot, "no-bundled-plugins"),
      OPENCLAW_PLUGIN_LOAD_PROFILE: "1",
      OPENCLAW_TEST_FAST: "1",
    };
    delete env.VITEST;

    const startedAt = Date.now();
    const result = spawnSync(
      process.execPath,
      [launcherPath, "memory-pro", "stats", "--json"],
      {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
        timeout: 1_500,
      },
    );
    const elapsedMs = Date.now() - startedAt;

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    const stdout = result.stdout.trim();
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(JSON.parse(stdout)).toMatchObject({
      retrieval: {
        mode: "hybrid",
        fts: { available: true, lastError: null },
      },
    });
    expect(elapsedMs).toBeLessThan(1_500);
    expect([...new Set(extractProfiledPlugins(`${result.stderr}\n${result.stdout}`))]).toEqual([
      "memory-lancedb-pro",
    ]);
  });
});
