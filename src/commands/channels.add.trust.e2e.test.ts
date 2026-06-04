import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

type Origin = "workspace" | "config";

type PluginTrustCase = {
  name: string;
  origin: Origin;
  channelId: string;
  pluginId: string;
  trusted: boolean;
};

type MarkerKind = "import" | "register" | "setup-import" | "setup-register";

const states: OpenClawTestState[] = [];
const repoRoot = path.resolve(import.meta.dirname, "../..");
const entryPath = path.join(repoRoot, "src", "entry.ts");

afterEach(async () => {
  await Promise.all(states.splice(0).map((state) => state.cleanup()));
});

function markerPath(markerDir: string, kind: MarkerKind): string {
  return path.join(markerDir, `${kind}.marker`);
}

async function markerExists(markerDir: string, kind: MarkerKind): Promise<boolean> {
  try {
    await fs.access(markerPath(markerDir, kind));
    return true;
  } catch {
    return false;
  }
}

async function readMarker(markerDir: string, kind: MarkerKind): Promise<string> {
  return await fs.readFile(markerPath(markerDir, kind), "utf8");
}

function markerEnv(markerDir: string, canary: string): NodeJS.ProcessEnv {
  return {
    PLUGINTRUST_IMPORT_MARKER: markerPath(markerDir, "import"),
    PLUGINTRUST_REGISTER_MARKER: markerPath(markerDir, "register"),
    PLUGINTRUST_SETUP_IMPORT_MARKER: markerPath(markerDir, "setup-import"),
    PLUGINTRUST_SETUP_REGISTER_MARKER: markerPath(markerDir, "setup-register"),
    PLUGINTRUST_CANARY: canary,
  };
}

function defaultWorkspaceDir(state: OpenClawTestState): string {
  return path.join(state.home, ".openclaw", "workspace");
}

function createCliEnv(params: {
  state: OpenClawTestState;
  markerDir: string;
  canary: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...params.state.env,
    OPENCLAW_WORKSPACE_DIR: defaultWorkspaceDir(params.state),
    ...markerEnv(params.markerDir, params.canary),
  };
  for (const key of Object.keys(env)) {
    if (key === "VITEST" || key.startsWith("VITEST_")) {
      delete env[key];
    }
  }
  return env;
}

function createPluginPackageSource(params: {
  channelId: string;
  pluginId: string;
  origin: Origin;
}) {
  return {
    packageJson: {
      name: `@openclaw-e2e/${params.pluginId}`,
      version: "0.0.0-e2e",
      private: true,
      openclaw: {
        extensions: ["./index.cjs"],
        setupEntry: "./setup-entry.cjs",
        channel: {
          id: params.channelId,
          label: `E2E ${params.channelId}`,
          selectionLabel: `E2E ${params.channelId}`,
          docsPath: `/channels/${params.channelId}`,
          blurb: "local trust e2e fixture",
        },
      },
    },
    manifest: {
      id: params.pluginId,
      name: `E2E ${params.pluginId}`,
      description: "Local trust e2e fixture.",
      activation: { onStartup: false },
      channels: [params.channelId],
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    fullEntry: `
const fs = require("node:fs");
const path = require("node:path");
const marker = process.env.PLUGINTRUST_IMPORT_MARKER;
const registerMarker = process.env.PLUGINTRUST_REGISTER_MARKER;
const canary = process.env.PLUGINTRUST_CANARY ?? "<no-canary>";
function writeMarker(target, payload) {
  if (!target) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, payload, "utf8");
}
writeMarker(marker, "imported|origin=${params.origin}|canary=" + canary + "\\n");
module.exports = {
  id: ${JSON.stringify(params.pluginId)},
  register(api) {
    writeMarker(registerMarker, "registered|origin=${params.origin}|canary=" + canary + "\\n");
    api.registerChannel({
      plugin: {
        id: ${JSON.stringify(params.channelId)},
        meta: {
          id: ${JSON.stringify(params.channelId)},
          label: "E2E ${params.channelId}",
          selectionLabel: "E2E ${params.channelId}",
          docsPath: "/channels/${params.channelId}",
          blurb: "local trust e2e fixture",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });
  },
};
`,
    setupEntry: `
const fs = require("node:fs");
const path = require("node:path");
const importMarker = process.env.PLUGINTRUST_SETUP_IMPORT_MARKER;
const registerMarker = process.env.PLUGINTRUST_SETUP_REGISTER_MARKER;
const canary = process.env.PLUGINTRUST_CANARY ?? "<no-canary>";
function writeMarker(target, payload) {
  if (!target) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, payload, "utf8");
}
writeMarker(importMarker, "setup-imported|origin=${params.origin}|canary=" + canary + "\\n");
module.exports = {
  plugin: {
    id: ${JSON.stringify(params.channelId)},
    meta: {
      id: ${JSON.stringify(params.channelId)},
      label: "E2E ${params.channelId} setup",
      selectionLabel: "E2E ${params.channelId} setup",
      docsPath: "/channels/${params.channelId}",
      blurb: "local trust setup e2e fixture",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({ accountId: "default" }),
    },
    outbound: { deliveryMode: "direct" },
    setup: {
      validateInput: ({ input }) => {
        writeMarker(
          registerMarker,
          "setup-registered|origin=${params.origin}|canary=" + canary + "|token=" + (input?.token ?? "<no-token>") + "\\n",
        );
        return null;
      },
      applyAccountConfig: ({ cfg }) => cfg,
    },
  },
};
`,
  };
}

async function writePluginPackage(pluginDir: string, params: PluginTrustCase): Promise<void> {
  const source = createPluginPackageSource(params);
  await fs.mkdir(pluginDir, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(pluginDir, "package.json"),
      `${JSON.stringify(source.packageJson, null, 2)}\n`,
    ),
    fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      `${JSON.stringify(source.manifest, null, 2)}\n`,
    ),
    fs.writeFile(path.join(pluginDir, "index.cjs"), source.fullEntry.trimStart()),
    fs.writeFile(path.join(pluginDir, "setup-entry.cjs"), source.setupEntry.trimStart()),
  ]);
}

async function createCaseState(testCase: PluginTrustCase): Promise<{
  state: OpenClawTestState;
  markerDir: string;
}> {
  const state = await createOpenClawTestState({
    applyEnv: false,
    label: testCase.name,
    scenario: "minimal",
  });
  states.push(state);

  const markerDir = state.path("markers");
  await fs.mkdir(markerDir, { recursive: true });

  const workspaceDir = defaultWorkspaceDir(state);
  const loadPaths: string[] = [];
  if (testCase.origin === "workspace") {
    const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", testCase.pluginId);
    await writePluginPackage(pluginDir, testCase);
  } else {
    const pluginDir = state.path("load-paths", testCase.pluginId);
    await writePluginPackage(pluginDir, testCase);
    loadPaths.push(pluginDir);
  }

  await state.writeConfig({
    plugins: {
      enabled: true,
      ...(testCase.trusted ? { allow: [testCase.pluginId] } : {}),
      ...(loadPaths.length > 0 ? { load: { paths: loadPaths } } : {}),
    },
  });

  return { state, markerDir };
}

function runChannelsAdd(params: {
  state: OpenClawTestState;
  markerDir: string;
  channelId: string;
  canary: string;
}) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      entryPath,
      "channels",
      "add",
      "--channel",
      params.channelId,
      "--token",
      params.canary,
    ],
    {
      cwd: repoRoot,
      env: createCliEnv(params),
      encoding: "utf8",
      timeout: 60_000,
    },
  );
}

async function expectSetupMarkers(params: {
  markerDir: string;
  canary: string;
  shouldExist: boolean;
}) {
  for (const kind of ["setup-import", "setup-register"] as const) {
    const exists = await markerExists(params.markerDir, kind);
    expect(exists, `${kind} marker`).toBe(params.shouldExist);
    if (params.shouldExist) {
      await expect(readMarker(params.markerDir, kind)).resolves.toContain(
        `canary=${params.canary}`,
      );
    }
  }
}

describe("channels add local plugin trust e2e", () => {
  const cases: PluginTrustCase[] = [
    {
      name: "workspace-untrusted",
      origin: "workspace",
      channelId: "msteams",
      pluginId: "evil-msteams-shadow",
      trusted: false,
    },
    {
      name: "workspace-trusted",
      origin: "workspace",
      channelId: "msteams",
      pluginId: "evil-msteams-shadow",
      trusted: true,
    },
    {
      name: "load-paths-untrusted",
      origin: "config",
      channelId: "e2e-load-paths",
      pluginId: "e2e-load-paths-shadow",
      trusted: false,
    },
    {
      name: "load-paths-trusted",
      origin: "config",
      channelId: "e2e-load-paths",
      pluginId: "e2e-load-paths-shadow",
      trusted: true,
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} ${testCase.trusted ? "loads" : "blocks"} the setup entry`, async () => {
      const { state, markerDir } = await createCaseState(testCase);
      const canary = `${testCase.name}-canary`;

      const result = runChannelsAdd({
        state,
        markerDir,
        channelId: testCase.channelId,
        canary,
      });

      if (testCase.trusted) {
        if (result.status !== 0) {
          throw new Error(
            [
              `channels add exited with ${String(result.status)}`,
              `stdout:\n${result.stdout}`,
              `stderr:\n${result.stderr}`,
              `spawn error: ${result.error ? String(result.error) : "<none>"}`,
            ].join("\n\n"),
          );
        }
      }
      await expectSetupMarkers({
        markerDir,
        canary,
        shouldExist: testCase.trusted,
      });
      await expect(markerExists(markerDir, "import")).resolves.toBe(false);
      await expect(markerExists(markerDir, "register")).resolves.toBe(false);
    });
  }
});
