import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { validateConfigObjectWithPlugins } from "./validation.js";

vi.unmock("../version.js");

describe("ACP model plugin validation", () => {
  let home: string;

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-model-plugin-validation-"));
  });

  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it.each([
    {
      name: "string harness primary",
      model: "openai/gpt-5.6",
      needsCodex: false,
    },
    {
      name: "object harness primary",
      model: { primary: "openai/gpt-5.6", fallbacks: [] },
      needsCodex: false,
    },
    {
      name: "native Codex fallback",
      model: { primary: "openai/gpt-5.6", fallbacks: ["openai/gpt-5.3-codex-spark"] },
      needsCodex: true,
    },
  ])("uses native plugin requirements for $name", ({ model, needsCodex }) => {
    const result = validateConfigObjectWithPlugins(
      {
        agents: {
          ownership: "explicit",
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
          },
          entries: {
            worker: {
              runtime: { type: "acp", acp: { agent: "cursor" } },
              model,
            },
          },
        },
        plugins: { entries: { codex: {} } },
      },
      {
        env: {
          HOME: home,
          OPENCLAW_HOME: undefined,
          OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
          OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
          OPENCLAW_VERSION: undefined,
          VITEST: "true",
        },
        pluginMetadataSnapshot: {
          manifestRegistry: { plugins: [], diagnostics: [] },
        },
      },
    );

    expect(result).toMatchObject({ ok: true });
    const missingCodexWarnings = (result.warnings ?? []).filter(
      (warning) =>
        warning.path === "plugins.entries.codex" &&
        warning.message.includes("plugin not installed: codex"),
    );
    expect(missingCodexWarnings).toHaveLength(needsCodex ? 1 : 0);
  });
});
