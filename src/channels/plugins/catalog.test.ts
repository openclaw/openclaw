import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listChannelPluginCatalogEntries } from "./catalog.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("listChannelPluginCatalogEntries", () => {
  it("does not reintroduce source-checkout bundled metadata when excludeWorkspace is true", () => {
    const packageRoot = createTempDir("openclaw-source-bundled-");
    const bundledDir = path.join(packageRoot, "extensions");
    const pluginDir = path.join(bundledDir, "demo-source-channel");
    fs.mkdirSync(path.join(packageRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/demo-source-channel",
        openclaw: {
          extensions: ["./index.js"],
          channel: {
            id: "demo-source-channel",
            label: "Demo Source Channel",
            selectionLabel: "Demo Source Channel",
            docsPath: "/channels/demo-source-channel",
            blurb: "source checkout bundled metadata",
          },
          install: {
            npmSpec: "@openclaw/demo-source-channel",
          },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "demo-source-channel",
        channels: ["demo-source-channel"],
        configSchema: {},
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(pluginDir, "index.js"), "export default {};\n", "utf8");

    const env = {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    };

    const includedIds = listChannelPluginCatalogEntries({
      workspaceDir: packageRoot,
      env,
    }).map((entry) => entry.id);
    expect(includedIds).toContain("demo-source-channel");

    const excludedIds = listChannelPluginCatalogEntries({
      workspaceDir: packageRoot,
      excludeWorkspace: true,
      env,
    }).map((entry) => entry.id);
    expect(excludedIds).not.toContain("demo-source-channel");
  });
});
