// Check Deadcode Exports tests cover parsing and hard-zero enforcement.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import knipConfig from "../../config/knip.config.ts";
import {
  checkUnusedExports,
  parseKnipCompactUnusedExports,
  parseKnipCompactUnusedExportsResult,
} from "../../scripts/check-deadcode-exports.mjs";

describe("check-deadcode-exports", () => {
  it("requests every unused-export issue class from Knip", () => {
    const script = fs.readFileSync(
      new URL("../../scripts/check-deadcode-exports.mjs", import.meta.url),
      "utf8",
    );
    expect(script).toContain('"exports,nsExports,types,nsTypes,enumMembers,namespaceMembers"');
  });

  it("excludes test support from every Knip issue type", () => {
    expect(knipConfig.ignore).toContain("dist/**");
    expect(knipConfig.ignore).toContain("**/test-helpers/**");
    expect(knipConfig.ignore).toContain("**/*.test-utils.ts");
    expect(knipConfig.ignoreFiles).not.toContain("**/test-helpers/**");
    expect(knipConfig.ignoreFiles).toContain("scripts/**");
    expect(knipConfig.ignoreFiles).toContain("dist/**");
    expect(knipConfig.ignore).not.toContain("**/live-*.ts");
    expect(knipConfig.ignoreFiles).toContain("**/live-*.ts");
  });

  it("tracks production script consumers of plugin exports", () => {
    expect(knipConfig.workspaces["."].entry).toContain("scripts/qa/render-maturity-docs.ts!");
  });

  it("models the jiti virtual agent-sessions SDK entry", () => {
    expect(knipConfig.workspaces["."].entry).toContain("src/agents/sessions/extension-sdk.ts!");
  });

  it("models the spawned system-agent MCP stdio entry", () => {
    expect(knipConfig.workspaces["."].entry).toContain("src/mcp/openclaw-tools-serve.ts!");
  });

  it.each([
    "amazon-bedrock-mantle",
    "azure-speech",
    "cloudflare-ai-gateway",
    "cohere",
    "deepgram",
    "elevenlabs",
    "featherless",
    "fireworks",
    "huggingface",
    "kilocode",
    "kimi-coding",
    "microsoft",
    "minimax",
    "mistral",
    "moonshot",
    "nvidia",
    "pixverse",
    "qianfan",
    "qwen",
    "senseaudio",
    "tavily",
    "tencent",
    "vllm",
    "xiaomi",
  ])("removes the bundled-plugin root catch-all from migrated %s workspace", (pluginId) => {
    const workspace = (
      knipConfig.workspaces as Record<string, { readonly entry: readonly string[] }>
    )[`extensions/${pluginId}`];
    if (!workspace) {
      throw new Error(`missing Knip workspace for ${pluginId}`);
    }
    const entries = workspace.entry;
    expect(entries).not.toContain("*.ts!");
    expect(entries).toEqual(
      expect.arrayContaining([
        "index.ts!",
        "setup-entry.ts!",
        "*-api.ts!",
        "cli-metadata.ts!",
        "channel-entry.ts!",
        "provider-discovery.ts!",
        "{web-search,web-fetch}-provider.ts!",
      ]),
    );
    expect(knipConfig.workspaces["extensions/*"].entry).toContain("*.ts!");
  });

  it.each([
    "packages/agent-core",
    "packages/markdown-core",
    "packages/media-core",
    "packages/acp-core",
    "packages/terminal-core",
  ] as const)("mirrors the published entry map for %s", (workspace) => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL(`../../${workspace}/package.json`, import.meta.url), "utf8"),
    ) as { exports: Record<string, unknown> };
    const expected = Object.keys(packageJson.exports)
      .map((subpath) =>
        subpath === "." ? "src/index.ts!" : `src/${subpath.slice("./".length)}.ts!`,
      )
      .toSorted();
    expect([...knipConfig.workspaces[workspace].entry].toSorted()).toEqual(expected);
  });

  it("parses all compact export sections and expands symbol lists", () => {
    expect(
      parseKnipCompactUnusedExports(`
Unused exports (2)
src/b.ts: beta, alpha
/tmp/outside.ts: noise

Unused exported types (1)
extensions/example/src/types.ts: ExampleType

Unused exported enum members (1)
packages/example/src/state.ts: Ready

Exports in used namespace (1)
src/namespace.ts: runtimeHelper

Exported types in used namespace (1)
src/namespace.ts: RuntimeType

Unused exported namespace members (1)
src/protocol.ts: Result (v2)

Unused files (1)
src/noise.ts: src/noise.ts
`),
    ).toEqual([
      "extensions/example/src/types.ts: ExampleType",
      "packages/example/src/state.ts: Ready",
      "src/b.ts: alpha",
      "src/b.ts: beta",
      "src/namespace.ts: runtimeHelper",
      "src/namespace.ts: RuntimeType",
      "src/protocol.ts: Result (v2)",
    ]);
  });

  it("distinguishes a failed scan with no export sections from zero findings", () => {
    expect(parseKnipCompactUnusedExportsResult("Configuration error: invalid project\n")).toEqual({
      entries: [],
      sawExportSection: false,
    });
    expect(parseKnipCompactUnusedExportsResult("Unused exports (0)\n")).toEqual({
      entries: [],
      sawExportSection: true,
    });
  });

  it("accepts an empty compact report with zero unused exports", () => {
    expect(checkUnusedExports("")).toEqual({
      ok: true,
      entries: [],
      message: "",
    });
  });

  it("rejects every unused export without an allowlist", () => {
    expect(
      checkUnusedExports(`Unused exports (2)
src/z.ts: zebra
src/a.ts: alpha
`),
    ).toEqual({
      ok: false,
      entries: ["src/a.ts: alpha", "src/z.ts: zebra"],
      message: `Unused exports are not allowed:
  src/a.ts: alpha
  src/z.ts: zebra
Delete the exports or model their real production consumers in Knip.`,
    });
  });
});
