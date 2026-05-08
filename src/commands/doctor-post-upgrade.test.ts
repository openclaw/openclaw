import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runPostUpgradeProbes } from "./doctor-post-upgrade.js";

async function makeFixtureRoot(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `doctor-post-upgrade-${prefix}-`));
}

describe("runPostUpgradeProbes — plugin.entry_unresolved", () => {
  it("flags an enabled plugin whose declared entry does not exist on disk", async () => {
    const root = await makeFixtureRoot("entry-unresolved");
    try {
      const pluginDir = path.join(root, "user-plugins", "ghost");
      await fs.mkdir(pluginDir, { recursive: true });
      // Plugin package.json declares ./dist/index.js but no dist/.
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "ghost",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./dist/index.js"] },
        }),
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "ghost" }),
        "utf-8",
      );

      const installsPath = path.join(root, "plugins", "installs.json");
      await fs.mkdir(path.dirname(installsPath), { recursive: true });
      await fs.writeFile(
        installsPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              pluginId: "ghost",
              manifestPath: path.join(pluginDir, "openclaw.plugin.json"),
              rootDir: pluginDir,
              enabled: true,
              packageJson: { path: "package.json" },
            },
          ],
        }),
        "utf-8",
      );

      const report = await runPostUpgradeProbes({ installsPath });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding).toBeDefined();
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("ghost");
      expect(finding?.entry).toBe("./dist/index.js");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits no entry_unresolved findings when the entry resolves", async () => {
    const root = await makeFixtureRoot("entry-ok");
    try {
      const pluginDir = path.join(root, "user-plugins", "good");
      await fs.mkdir(path.join(pluginDir, "dist"), { recursive: true });
      await fs.writeFile(path.join(pluginDir, "dist", "index.js"), "export default {};", "utf-8");
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "good",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./dist/index.js"] },
        }),
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "good" }),
        "utf-8",
      );

      const installsPath = path.join(root, "plugins", "installs.json");
      await fs.mkdir(path.dirname(installsPath), { recursive: true });
      await fs.writeFile(
        installsPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              pluginId: "good",
              manifestPath: path.join(pluginDir, "openclaw.plugin.json"),
              rootDir: pluginDir,
              enabled: true,
              packageJson: { path: "package.json" },
            },
          ],
        }),
        "utf-8",
      );

      const report = await runPostUpgradeProbes({ installsPath });
      expect(report.findings.filter((f) => f.code === "plugin.entry_unresolved")).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
