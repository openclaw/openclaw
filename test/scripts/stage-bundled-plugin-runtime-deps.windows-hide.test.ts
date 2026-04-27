import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const { stageBundledPluginRuntimeDeps } =
  await import("../../scripts/stage-bundled-plugin-runtime-deps.mjs");

const spawnSyncMock = vi.mocked(spawnSync);
const { createTempDir } = createScriptTestHarness();

describe("stageBundledPluginRuntimeDeps npm spawn options", () => {
  it("hides npm install windows while staging fallback runtime deps", () => {
    const repoRoot = createTempDir("openclaw-runtime-deps-windows-hide-");
    const pluginDir = path.join(repoRoot, "dist", "extensions", "fixture-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      `${JSON.stringify(
        {
          name: "@openclaw/fixture-plugin",
          version: "1.0.0",
          dependencies: { "left-pad": "1.3.0" },
          openclaw: { bundle: { stageRuntimeDependencies: true } },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    spawnSyncMock.mockImplementation((_command, _args, options) => {
      const cwd = String(options?.cwd ?? "");
      const depDir = path.join(cwd, "node_modules", "left-pad");
      fs.mkdirSync(depDir, { recursive: true });
      fs.writeFileSync(
        path.join(depDir, "package.json"),
        '{"name":"left-pad","version":"1.3.0"}\n',
        "utf8",
      );
      return { status: 0, stdout: "", stderr: "" } as ReturnType<typeof spawnSync>;
    });

    stageBundledPluginRuntimeDeps({ cwd: repoRoot });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        cwd: expect.stringContaining(path.join("fixture-plugin", ".openclaw-runtime-deps-install")),
        windowsHide: true,
      }),
    );
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "left-pad", "package.json"))).toBe(
      true,
    );
  });
});
