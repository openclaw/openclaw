import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { resolveOperatorReferenceSourcePath } from "./reference-paths.js";

describe("operator reference paths", () => {
  it("resolves reference files under the workspace memory directory", () => {
    expect(
      resolveOperatorReferenceSourcePath("operator-specialty-family-vocabulary.yaml", {
        workspaceDir: "/tmp/tonya-home",
      }),
    ).toBe(
      path.join(
        "/tmp/tonya-home",
        "memory",
        "reference",
        "operator-specialty-family-vocabulary.yaml",
      ),
    );
  });

  it("honors an explicit source path override", () => {
    expect(
      resolveOperatorReferenceSourcePath("ignored.yaml", {
        sourcePath: "/tmp/custom/operator-review-handle-vocabulary.yaml",
      }),
    ).toBe(path.resolve("/tmp/custom/operator-review-handle-vocabulary.yaml"));
  });

  it("falls back to the default workspace when config is invalid", async () => {
    await withTempDir("operator-reference-invalid-config-", async (homeDir) => {
      const stateDir = path.join(homeDir, ".openclaw");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: {
              memorySearch: {
                fallback: "invalid-provider",
              },
            },
          },
        }),
        "utf8",
      );

      clearRuntimeConfigSnapshot();
      clearConfigCache();
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_HOME: undefined,
          OPENCLAW_CONFIG_PATH: undefined,
          CLAWDBOT_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
          CLAWDBOT_STATE_DIR: undefined,
        },
        async () => {
          expect(resolveOperatorReferenceSourcePath("agents.yaml")).toBe(
            path.join(homeDir, ".openclaw", "workspace", "memory", "reference", "agents.yaml"),
          );
        },
      );
      clearRuntimeConfigSnapshot();
      clearConfigCache();
    });
  });

  it("does not hydrate repo dotenv when resolving isolated test reference paths", async () => {
    await withTempDir("operator-reference-dotenv-cwd-", async (cwdDir) => {
      await fs.writeFile(path.join(cwdDir, ".env"), "OPENCLAW_PROFILE=dotenv-profile\n", "utf8");

      const previousCwd = process.cwd();
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      await withEnvAsync(
        {
          OPENCLAW_PROFILE: undefined,
        },
        async () => {
          process.chdir(cwdDir);
          try {
            expect(resolveOperatorReferenceSourcePath("agents.yaml")).toBe(
              path.join(
                process.env.HOME ?? "",
                ".openclaw",
                "workspace",
                "memory",
                "reference",
                "agents.yaml",
              ),
            );
            expect(process.env.OPENCLAW_PROFILE).toBeUndefined();
          } finally {
            process.chdir(previousCwd);
          }
        },
      );
      clearRuntimeConfigSnapshot();
      clearConfigCache();
    });
  });
});
