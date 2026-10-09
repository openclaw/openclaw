import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { validateConfigObjectWithPlugins } from "./validation.js";

vi.unmock("../version.js");

let fixtureRoot = "";
let suiteHome = "";
let comfySchemaPluginDir = "";

async function chmodSafeDir(dir: string) {
  if (process.platform !== "win32") {
    await fs.chmod(dir, 0o755);
  }
}

async function mkdirSafe(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  await chmodSafeDir(dir);
}

async function writePluginFixture(dir: string, schema: Record<string, unknown>) {
  await mkdirSafe(dir);
  await fs.writeFile(
    path.join(dir, "index.js"),
    'export default { id: "comfy", register() {} };',
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({ id: "comfy", configSchema: schema }, null, 2),
    "utf-8",
  );
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-comfy-config-validation-"));
  await chmodSafeDir(fixtureRoot);
  suiteHome = path.join(fixtureRoot, "home");
  await mkdirSafe(suiteHome);

  const manifestPath = path.join(process.cwd(), "extensions", "comfy", "openclaw.plugin.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
    configSchema?: Record<string, unknown>;
  };
  if (!manifest.configSchema) {
    throw new Error("comfy manifest missing configSchema");
  }
  comfySchemaPluginDir = path.join(suiteHome, "comfy-schema-plugin");
  await writePluginFixture(comfySchemaPluginDir, manifest.configSchema);
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

it("accepts Comfy workflow settings under the canonical plugin config root", () => {
  const res = validateConfigObjectWithPlugins(
    {
      agents: { entries: { openclaw: {} } },
      plugins: {
        enabled: true,
        load: { paths: [comfySchemaPluginDir] },
        entries: {
          comfy: {
            config: {
              workflowFileMaxBytes: 100 * 1024 * 1024,
              image: {
                workflowPath: "./workflow.json",
                promptNodeId: "6",
              },
            },
          },
        },
      },
    },
    {
      env: {
        HOME: suiteHome,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: path.join(suiteHome, ".openclaw"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_VERSION: undefined,
        VITEST: "true",
      },
    },
  );

  expect(res.ok).toBe(true);
});
