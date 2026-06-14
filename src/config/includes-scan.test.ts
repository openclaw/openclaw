import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { collectIncludePathsRecursive } from "./includes-scan.js";

describe("collectIncludePathsRecursive", () => {
  const configPath = path.join(path.parse(process.cwd()).root, "cfg", "openclaw.json");
  const resolved = (rel: string) => path.normalize(path.join(path.dirname(configPath), rel));

  it("registers $include paths as watched dependencies", async () => {
    const result = await collectIncludePathsRecursive({
      configPath,
      parsed: { agents: { $include: "./agents.json" } },
    });
    expect(result).toContain(resolved("agents.json"));
  });

  it("registers $includeText paths as watched dependencies", async () => {
    const result = await collectIncludePathsRecursive({
      configPath,
      parsed: {
        channels: {
          discord: {
            guilds: {
              g1: {
                channels: { c1: { systemPrompt: { $includeText: "./prompts/c1.md" } } },
              },
            },
          },
        },
      },
    });
    expect(result).toContain(resolved("prompts/c1.md"));
  });

  it("does not recurse into $includeText leaves even when they contain include directives", async () => {
    await withTempDir({ prefix: "openclaw-scan-text-" }, async (tempRoot) => {
      const cfg = path.join(tempRoot, "openclaw.json");
      // Raw text that *would* parse as a nested $include if (wrongly) descended into.
      await fs.writeFile(
        path.join(tempRoot, "prompt.md"),
        '{"$include":"./nested.json"}\n',
        "utf-8",
      );
      const result = await collectIncludePathsRecursive({
        configPath: cfg,
        parsed: { systemPrompt: { $includeText: "./prompt.md" } },
      });
      expect(result).toContain(path.normalize(path.join(tempRoot, "prompt.md")));
      expect(result).not.toContain(path.normalize(path.join(tempRoot, "nested.json")));
    });
  });
});
