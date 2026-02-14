import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolvePluginTools } from "./tools.js";

type TempPlugin = { dir: string; file: string; id: string };

const fixtureRoot = path.join(os.tmpdir(), `openclaw-plugin-tools-${randomUUID()}`);
const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };

function makeFixtureDir(id: string) {
  const dir = path.join(fixtureRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writePlugin(params: { id: string; body: string }): TempPlugin {
  const dir = makeFixtureDir(params.id);
  const file = path.join(dir, `${params.id}.js`);
  fs.writeFileSync(file, params.body, "utf-8");
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        configSchema: EMPTY_PLUGIN_SCHEMA,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return { dir, file, id: params.id };
}

const pluginBody = `
export default { register(api) {
  api.registerTool(
    {
      name: "optional_tool",
      description: "optional tool",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    },
    { optional: true },
  );
} }
`;

const optionalDemoPlugin = writePlugin({ id: "optional-demo", body: pluginBody });
const coreNameCollisionPlugin = writePlugin({ id: "message", body: pluginBody });
const multiToolPlugin = writePlugin({
  id: "multi",
  body: `
export default { register(api) {
  api.registerTool({
    name: "message",
    description: "conflict",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "nope" }] };
    },
  });
  api.registerTool({
    name: "other_tool",
    description: "ok",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
} }
`,
});

afterAll(() => {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

describe("resolvePluginTools optional tools", () => {
  it("skips optional tools without explicit allowlist", () => {
    const tools = resolvePluginTools({
      context: {
        config: {
          plugins: {
            load: { paths: [optionalDemoPlugin.file] },
            allow: [optionalDemoPlugin.id],
          },
        },
        workspaceDir: optionalDemoPlugin.dir,
      },
    });
    expect(tools).toHaveLength(0);
  });

  it("allows optional tools by name", () => {
    const tools = resolvePluginTools({
      context: {
        config: {
          plugins: {
            load: { paths: [optionalDemoPlugin.file] },
            allow: [optionalDemoPlugin.id],
          },
        },
        workspaceDir: optionalDemoPlugin.dir,
      },
      toolAllowlist: ["optional_tool"],
    });
    expect(tools.map((tool) => tool.name)).toContain("optional_tool");
  });

  it("allows optional tools via plugin groups", () => {
    const toolsAll = resolvePluginTools({
      context: {
        config: {
          plugins: {
            load: { paths: [optionalDemoPlugin.file] },
            allow: [optionalDemoPlugin.id],
          },
        },
        workspaceDir: optionalDemoPlugin.dir,
      },
      toolAllowlist: ["group:plugins"],
    });
    expect(toolsAll.map((tool) => tool.name)).toContain("optional_tool");

    const toolsPlugin = resolvePluginTools({
      context: {
        config: {
          plugins: {
            load: { paths: [optionalDemoPlugin.file] },
            allow: [optionalDemoPlugin.id],
          },
        },
        workspaceDir: optionalDemoPlugin.dir,
      },
      toolAllowlist: ["optional-demo"],
    });
    expect(toolsPlugin.map((tool) => tool.name)).toContain("optional_tool");
  });

  it("rejects plugin id collisions with core tool names", () => {
    const tools = resolvePluginTools({
      context: {
        config: {
          plugins: {
            load: { paths: [coreNameCollisionPlugin.file] },
            allow: [coreNameCollisionPlugin.id],
          },
        },
        workspaceDir: coreNameCollisionPlugin.dir,
      },
      existingToolNames: new Set(["message"]),
      toolAllowlist: ["message"],
    });
    expect(tools).toHaveLength(0);
  });

  it("skips conflicting tool names but keeps other tools", () => {
    const tools = resolvePluginTools({
      context: {
        config: {
          plugins: {
            load: { paths: [multiToolPlugin.file] },
            allow: [multiToolPlugin.id],
          },
        },
        workspaceDir: multiToolPlugin.dir,
      },
      existingToolNames: new Set(["message"]),
    });

    expect(tools.map((tool) => tool.name)).toEqual(["other_tool"]);
  });
});
