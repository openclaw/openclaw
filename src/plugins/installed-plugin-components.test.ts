import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginDeclaredSurface } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { projectInstalledPluginComponents } from "./installed-plugin-components.js";
import type { PluginManifestRecord } from "./manifest-registry.js";

const emptyDeclared: PluginDeclaredSurface = {
  channels: [],
  providers: [],
  tools: [],
  contracts: [],
  hooks: [],
  mcpServers: [],
  cliCommands: [],
  cliBackends: [],
  skills: [],
  dangerousConfigFlags: [],
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("projectInstalledPluginComponents", () => {
  it("projects declared native components as runtime-mapped tabs", () => {
    expect(
      projectInstalledPluginComponents({
        manifest: { id: "native", format: "openclaw" } as PluginManifestRecord,
        declared: {
          ...emptyDeclared,
          skills: ["triage"],
          cliCommands: ["sync"],
          hooks: ["before_prompt_build"],
        },
      }),
    ).toMatchObject({
      mapped: ["skills", "commands", "hooks"],
      skills: ["triage"],
      commands: ["sync"],
      hooks: ["before_prompt_build"],
    });
  });

  it("keeps detected-only Cursor capabilities unavailable instead of exposing tabs", () => {
    expect(
      projectInstalledPluginComponents({
        manifest: {
          id: "cursor-bundle",
          format: "bundle",
          bundleFormat: "cursor",
          bundleCapabilities: ["skills", "commands", "agents", "hooks", "rules"],
        } as PluginManifestRecord,
        declared: { ...emptyDeclared, skills: ["review"] },
      }),
    ).toEqual({
      mapped: ["commands", "skills"],
      skills: ["review"],
      mcpServers: [],
      commands: [],
      hooks: [],
      lspServers: [],
      unavailable: {
        capabilities: ["agents", "hooks", "rules"],
        mcpServers: [],
        lspServers: [],
      },
    });
  });

  it("projects skill metadata names instead of manifest root paths", () => {
    const rootDir = tempDirs.make("openclaw-plugin-skills-");
    const skillDir = path.join(rootDir, "skills", "discord");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: discord\ndescription: Discord workflows.\n---\n\n# Discord\n",
    );

    expect(
      projectInstalledPluginComponents({
        manifest: {
          id: "discord",
          format: "openclaw",
          origin: "bundled",
          rootDir,
          skills: ["./skills"],
        } as PluginManifestRecord,
        declared: { ...emptyDeclared, skills: ["./skills"] },
      }).skills,
    ).toEqual(["discord"]);
  });
});
