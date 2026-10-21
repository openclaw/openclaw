import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const pluginId = "authoring-proof";
const invalidConfig = '{"gateway":{"port":"invalid"}}\n';

async function createAuthoringFixture(root: string) {
  const project = path.join(root, "project");
  await fs.mkdir(project, { recursive: true });
  const files = {
    "package.json": JSON.stringify({
      name: "openclaw-plugin-authoring-proof",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.ts"] },
    }),
    "index.ts": `import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
export default defineToolPlugin({
  id: "authoring-proof", name: "Authoring Proof", description: "Authoring fixture.",
  tools: (tool) => [tool({
    name: "echo", description: "Echo input.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ ok: true }),
  })],
});
`,
    "openclaw.plugin.json": JSON.stringify({
      id: pluginId,
      name: "Authoring Proof",
      description: "Authoring fixture.",
      version: "1.0.0",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      activation: { onStartup: true },
      contracts: { tools: ["echo"] },
    }),
  };
  for (const [name, contents] of Object.entries(files)) {
    await fs.writeFile(path.join(project, name), contents);
  }
  return project;
}

async function runPlugins(root: string, args: string[]) {
  const configPath = path.join(root, "openclaw.json");
  await fs.writeFile(configPath, invalidConfig);
  const result = await runCliProcessChild({
    nodeArgs: ["--import", "tsx", path.resolve("src", "entry.ts"), "plugins", ...args],
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      NODE_DISABLE_COMPILE_CACHE: "1",
      NODE_ENV: undefined,
      NODE_OPTIONS: undefined,
      NO_COLOR: "1",
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_HIDE_BANNER: "1",
      OPENCLAW_HOME: root,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      VITEST: undefined,
      VITEST_POOL_ID: undefined,
      VITEST_WORKER_ID: undefined,
    },
  });
  expect(await fs.readFile(configPath, "utf8")).toBe(invalidConfig);
  return result;
}

it.each(["init", "build", "validate"] as const)(
  "runs plugins %s against its target package",
  async (command) => {
    const root = tempDirs.make("openclaw-plugin-authoring-process-");
    const project =
      command === "init" ? path.join(root, "project") : await createAuthoringFixture(root);
    if (command === "build") {
      await fs.unlink(path.join(project, "openclaw.plugin.json"));
    }
    const args =
      command === "init"
        ? [command, pluginId, "--directory", project]
        : [command, "--root", project, ...(command === "validate" ? ["--json"] : [])];

    const result = await runPlugins(root, args);

    expect(result.code, result.stderr).toBe(0);
    const manifest = JSON.parse(
      await fs.readFile(path.join(project, "openclaw.plugin.json"), "utf8"),
    );
    expect(manifest).toMatchObject({ id: pluginId, contracts: { tools: ["echo"] } });
    if (command === "validate") {
      expect(JSON.parse(result.stdout)).toEqual({ valid: true, pluginId, errors: [] });
    }
  },
);

it("still rejects invalid host config for plugin enable", async () => {
  const root = tempDirs.make("openclaw-plugin-enable-process-");
  const result = await runPlugins(root, ["enable", pluginId]);
  expect(result.code, result.stderr).toBe(1);
  expect(result.stderr).toContain("OpenClaw config is invalid");
});
