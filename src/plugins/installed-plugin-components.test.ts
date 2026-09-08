import { describe, expect, it } from "vitest";
import type { PluginDeclaredSurface } from "../../packages/gateway-protocol/src/schema/plugins.js";
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
});
