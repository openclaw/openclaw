/** Ensures bundled plugin command manifests are scanned without loading command runtimes. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { PluginManifestRecord } from "./manifest-registry.js";

const mocks = vi.hoisted(() => ({
  plugins: [] as PluginManifestRecord[],
  warn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: mocks.warn }),
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: () => ({ diagnostics: [], plugins: mocks.plugins }),
}));

vi.mock("./plugin-registry-contributions.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => ({ diagnostics: [], plugins: mocks.plugins }),
}));

vi.mock("./config-state.js", () => ({
  hasExplicitPluginConfig: (plugins?: { entries?: Record<string, unknown> }) =>
    Boolean(plugins?.entries && Object.keys(plugins.entries).length > 0),
  normalizePluginsConfig: (plugins?: unknown) => plugins,
  resolveEffectivePluginActivationState: (params: {
    config?: { entries?: Record<string, { enabled?: boolean }> };
    id: string;
  }) => ({
    activated: params.config?.entries?.[params.id]?.enabled !== false,
  }),
}));

const { loadEnabledClaudeBundleCommands } = await import("./bundle-commands.js");

const tempDirs = createTempDirTracker();

afterEach(() => {
  mocks.plugins = [];
  mocks.warn.mockReset();
  tempDirs.cleanup();
});

function resolveBundlePluginRoot(homeDir: string, pluginId: string) {
  return path.join(homeDir, ".openclaw", "extensions", pluginId);
}

async function writeClaudeBundleCommandFixture(params: {
  homeDir: string;
  pluginId: string;
  commands: Record<string, string>;
}) {
  const pluginRoot = resolveBundlePluginRoot(params.homeDir, params.pluginId);
  await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: params.pluginId }, null, 2)}\n`,
    "utf-8",
  );
  await Promise.all(
    Object.entries(params.commands).map(async ([relativePath, contents]) => {
      const filePath = path.join(pluginRoot, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, `${contents}\n`, "utf-8");
    }),
  );
  mocks.plugins = [
    {
      id: params.pluginId,
      format: "bundle",
      bundleFormat: "claude",
      bundleCapabilities: ["commands"],
      origin: "global",
      rootDir: pluginRoot,
    } as PluginManifestRecord,
  ];
}

function markdown(body: string, ...frontmatter: string[]) {
  return ["---", ...frontmatter, "---", body].join("\n");
}

function loadCommands(workspaceDir: string, pluginId: string) {
  return loadEnabledClaudeBundleCommands({
    workspaceDir,
    cfg: { plugins: { entries: { [pluginId]: { enabled: true } } } },
  });
}

describe("loadEnabledClaudeBundleCommands", () => {
  it("loads enabled Claude bundle markdown commands and honors invocation policy", async () => {
    const homeDir = tempDirs.make("openclaw-bundle-commands-home-");
    const workspaceDir = tempDirs.make("openclaw-bundle-commands-workspace-");
    await withEnvAsync(
      {
        HOME: homeDir,
        USERPROFILE: homeDir,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: undefined,
      },
      async () => {
        await writeClaudeBundleCommandFixture({
          homeDir,
          pluginId: "compound-bundle",
          commands: {
            "commands/office-hours.MD": markdown(
              "Give direct engineering advice.",
              "description: Help with scoping and architecture",
            ),
            "commands/workflows/review.md": markdown(
              "Review the code. $ARGUMENTS",
              "name: workflows:review",
              "description: Run a structured review",
            ),
            "commands/model-hidden.md": markdown("Manual only.", "disable-model-invocation: on"),
            "commands/user-enabled.md": markdown("User enabled.", "user-invocable: on"),
            "commands/user-hidden.md": markdown("User hidden.", "user-invocable: off"),
            "commands/user-hidden-false.md": markdown("User hidden.", "user-invocable: false"),
            "commands/not-frontmatter.md": "---not\nname: nope\n---not\nTreat this as Markdown.",
            "commands/.hidden.md": "Hidden file.",
            "commands/.hidden/nested.md": "Hidden directory.",
          },
        });

        const commands = loadCommands(workspaceDir, "compound-bundle");

        const command = (
          rawName: string,
          file: string,
          promptTemplate: string,
          description = promptTemplate,
        ) => ({
          pluginId: "compound-bundle",
          rawName,
          description,
          promptTemplate,
          sourceFilePath: path.join(
            resolveBundlePluginRoot(homeDir, "compound-bundle"),
            "commands",
            file,
          ),
        });
        expect(commands).toEqual([
          command("model-hidden", "model-hidden.md", "Manual only."),
          command(
            "not-frontmatter",
            "not-frontmatter.md",
            "---not\nname: nope\n---not\nTreat this as Markdown.",
            "---not",
          ),
          command(
            "office-hours",
            "office-hours.MD",
            "Give direct engineering advice.",
            "Help with scoping and architecture",
          ),
          command("user-enabled", "user-enabled.md", "User enabled."),
          command(
            "workflows:review",
            "workflows/review.md",
            "Review the code. $ARGUMENTS",
            "Run a structured review",
          ),
        ]);
        const rawNames = commands.map((entry) => entry.rawName);
        expect(rawNames).not.toContain("user-hidden");
        expect(rawNames).not.toContain("user-hidden-false");
      },
    );
  });

  it("warns and skips oversized bundle commands without dropping siblings", async () => {
    const homeDir = tempDirs.make("openclaw-bundle-commands-oversized-");
    const workspaceDir = tempDirs.make("openclaw-bundle-commands-oversized-ws-");

    await writeClaudeBundleCommandFixture({
      homeDir,
      pluginId: "oversized-test",
      commands: {
        "commands/normal.md": markdown(
          "This is a normal command.",
          "description: Normal command that should be loaded",
        ),
      },
    });

    const pluginRoot = resolveBundlePluginRoot(homeDir, "oversized-test");
    const oversizedFilePath = path.join(pluginRoot, "commands", "oversized.md");
    await fs.mkdir(path.dirname(oversizedFilePath), { recursive: true });
    const oversizedContent = Buffer.alloc(1 * 1024 * 1024 + 1, "x");
    await fs.writeFile(oversizedFilePath, oversizedContent);

    const commands = loadCommands(workspaceDir, "oversized-test");

    expect(commands.map((entry) => entry.rawName)).toEqual(["normal"]);
    expect(mocks.warn).toHaveBeenCalledOnce();
    const warning = String(mocks.warn.mock.calls[0]?.[0]);
    expect(warning).toContain(oversizedFilePath);
    expect(warning).toContain("1048576");
  });
});
