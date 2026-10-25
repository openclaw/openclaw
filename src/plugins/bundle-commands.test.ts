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

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: mocks.warn,
      debug: vi.fn(),
      trace: vi.fn(),
    }),
  };
});

vi.mock("./plugin-registry-contributions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-registry-contributions.js")>()),
  loadPluginManifestRegistryForPluginRegistry: () => ({ diagnostics: [], plugins: mocks.plugins }),
}));

const { buildWorkspaceSkillCommandSpecs } = await import("../skills/discovery/command-specs.js");

const tempDirs = createTempDirTracker();

afterEach(() => {
  mocks.plugins = [];
  mocks.warn.mockReset();
  tempDirs.cleanup();
});

async function writeCommands(homeDir: string, commands: Record<string, string | Buffer>) {
  const pluginRoot = path.join(homeDir, ".openclaw", "extensions", "fixture");
  await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "fixture" }),
    "utf-8",
  );
  await Promise.all(
    Object.entries(commands).map(async ([relativePath, contents]) => {
      const filePath = path.join(pluginRoot, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, typeof contents === "string" ? `${contents}\n` : contents);
    }),
  );
  mocks.plugins = [
    {
      id: "fixture",
      format: "bundle",
      bundleFormat: "claude",
      bundleCapabilities: ["commands"],
      origin: "global",
      rootDir: pluginRoot,
    } as PluginManifestRecord,
  ];
  return pluginRoot;
}

function markdown(body: string, ...frontmatter: string[]) {
  return ["---", ...frontmatter, "---", body].join("\n");
}

function loadCommands() {
  const workspaceDir = tempDirs.make("openclaw-bundle-commands-workspace-");
  return buildWorkspaceSkillCommandSpecs(workspaceDir, {
    entries: [],
    config: { plugins: { entries: { fixture: { enabled: true } } } },
  });
}

describe("Claude bundle command discovery", () => {
  it("loads enabled Claude bundle markdown commands and honors invocation policy", async () => {
    const homeDir = tempDirs.make("openclaw-bundle-commands-home-");
    await withEnvAsync(
      {
        HOME: homeDir,
        USERPROFILE: homeDir,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: undefined,
      },
      async () => {
        const pluginRoot = await writeCommands(homeDir, {
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
        });

        const commands = loadCommands();

        const expected: Array<[string, string, string, string, string?]> = [
          ["model_hidden", "model-hidden", "model-hidden.md", "Manual only."],
          [
            "not_frontmatter",
            "not-frontmatter",
            "not-frontmatter.md",
            "---not\nname: nope\n---not\nTreat this as Markdown.",
            "---not",
          ],
          [
            "office_hours",
            "office-hours",
            "office-hours.MD",
            "Give direct engineering advice.",
            "Help with scoping and architecture",
          ],
          ["user_enabled", "user-enabled", "user-enabled.md", "User enabled."],
          [
            "workflows_review",
            "workflows:review",
            "workflows/review.md",
            "Review the code. $ARGUMENTS",
            "Run a structured review",
          ],
        ];
        expect(commands).toEqual(
          expected.map(([name, skillName, file, promptTemplate, description = promptTemplate]) => ({
            name,
            skillName,
            description,
            modelVisible: false,
            promptTemplate,
            sourceFilePath: path.join(pluginRoot, "commands", file),
          })),
        );
      },
    );
  });

  it("warns and skips oversized bundle commands without dropping siblings", async () => {
    const homeDir = tempDirs.make("openclaw-bundle-commands-oversized-");
    const pluginRoot = await writeCommands(homeDir, {
      "commands/normal.md": markdown(
        "This is a normal command.",
        "description: Normal command that should be loaded",
      ),
      "commands/oversized.md": Buffer.alloc(1024 * 1024 + 1, "x"),
    });

    const oversizedFilePath = path.join(pluginRoot, "commands", "oversized.md");
    const commands = loadCommands();

    expect(commands.map((entry) => entry.skillName)).toEqual(["normal"]);
    expect(mocks.warn).toHaveBeenCalledOnce();
    const warning = String(mocks.warn.mock.calls[0]?.[0]);
    expect(warning).toContain(oversizedFilePath);
    expect(warning).toContain("1048576");
  });
});
