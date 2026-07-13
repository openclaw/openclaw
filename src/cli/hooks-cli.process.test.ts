// Hooks CLI process tests cover plugin-owned handles that outlive command output.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

async function createLingeringPluginFixture(): Promise<{
  configPath: string;
  markerPath: string;
  stateDir: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hooks-cli-"));
  tempDirs.push(root);
  const stateDir = path.join(root, "state");
  const pluginDir = path.join(root, "linger-plugin");
  const markerPath = path.join(root, "registered");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "linger-plugin",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "linger",
      name: "Linger",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    [
      'import fs from "node:fs";',
      "export default {",
      '  id: "linger",',
      '  name: "Linger",',
      "  register() {",
      '    fs.writeFileSync(process.env.LINGER_MARKER, "registered\\n");',
      "    setInterval(() => {}, 60_000);",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      plugins: {
        load: { paths: [pluginDir] },
        entries: { linger: { enabled: true } },
      },
    }),
  );
  return { configPath, markerPath, stateDir };
}

async function runHooksList(fixture: Awaited<ReturnType<typeof createLingeringPluginFixture>>) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/entry.ts", "hooks", "list", "--json"],
    {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        LINGER_MARKER: fixture.markerPath,
        OPENCLAW_CONFIG_PATH: fixture.configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: fixture.stateDir,
        NODE_ENV: undefined,
        VITEST: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("hooks list did not exit after emitting output"));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout });
    });
  });
}

describe("hooks CLI process lifecycle", () => {
  it("exits after JSON output when plugin registration leaves a ref'd handle", async () => {
    const fixture = await createLingeringPluginFixture();

    const result = await runHooksList(fixture);

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(result.stderr).not.toContain("Error:");
    expect(JSON.parse(result.stdout)).toMatchObject({ hooks: expect.any(Array) });
    await expect(fs.readFile(fixture.markerPath, "utf8")).resolves.toBe("registered\n");
  }, 20_000);
});
