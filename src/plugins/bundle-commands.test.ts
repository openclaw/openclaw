import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { loadEnabledClaudeBundleCommands } from "./bundle-commands.js";
import { createBundleMcpTempHarness } from "./bundle-mcp.test-support.js";

const tempHarness = createBundleMcpTempHarness();

afterEach(async () => {
  await tempHarness.cleanup();
});

async function withBundleHomeEnv<T>(
  prefix: string,
  run: (params: { homeDir: string; workspaceDir: string }) => Promise<T>,
): Promise<T> {
  const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
  try {
    const homeDir = await tempHarness.createTempDir(`${prefix}-home-`);
    const workspaceDir = await tempHarness.createTempDir(`${prefix}-workspace-`);
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.OPENCLAW_HOME;
    delete process.env.OPENCLAW_STATE_DIR;
    return await run({ homeDir, workspaceDir });
  } finally {
    env.restore();
  }
}

async function writeClaudeBundleCommandFixture(params: {
  homeDir: string;
  pluginId: string;
  commands: Array<{ relativePath: string; contents: string[] }>;
}) {
  const pluginRoot = path.join(params.homeDir, ".openclaw", "extensions", params.pluginId);
  await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: params.pluginId }, null, 2)}\n`,
    "utf-8",
  );
  for (const command of params.commands) {
    await fs.mkdir(path.dirname(path.join(pluginRoot, command.relativePath)), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, command.relativePath),
      [...command.contents, ""].join("\n"),
      "utf-8",
    );
  }
}

describe("loadEnabledClaudeBundleCommands", () => {
  it("loads enabled Claude bundle markdown commands and skips disabled-model-invocation entries", async () => {
    await withBundleHomeEnv("openclaw-bundle-commands", async ({ homeDir, workspaceDir }) => {
      await writeClaudeBundleCommandFixture({
        homeDir,
        pluginId: "compound-bundle",
        commands: [
          {
            relativePath: "commands/office-hours.md",
            contents: [
              "---",
              "description: Help with scoping and architecture",
              "---",
              "Give direct engineering advice.",
            ],
          },
          {
            relativePath: "commands/workflows/review.md",
            contents: [
              "---",
              "name: workflows:review",
              "description: Run a structured review",
              "---",
              "Review the code. $ARGUMENTS",
            ],
          },
          {
            relativePath: "commands/disabled.md",
            contents: ["---", "disable-model-invocation: true", "---", "Do not load me."],
          },
        ],
      });

      const commands = loadEnabledClaudeBundleCommands({
        workspaceDir,
        cfg: {
          plugins: {
            entries: {
              "compound-bundle": { enabled: true },
            },
          },
        },
      });

      expect(commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: "compound-bundle",
            rawName: "office-hours",
            description: "Help with scoping and architecture",
            promptTemplate: "Give direct engineering advice.",
          }),
          expect.objectContaining({
            pluginId: "compound-bundle",
            rawName: "workflows:review",
            description: "Run a structured review",
            promptTemplate: "Review the code. $ARGUMENTS",
          }),
        ]),
      );
      expect(commands.some((entry) => entry.rawName === "disabled")).toBe(false);
    });
  });
});
