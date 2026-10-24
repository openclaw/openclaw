// Prune Docker Plugin Dist tests cover prune docker plugin dist script behavior.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { pruneDockerPluginDist } from "../../scripts/prune-docker-plugin-dist.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("pruneDockerPluginDist", () => {
  it("keeps SDK imports working for retained plugins while pruning omitted plugins", () => {
    const rootDir = createTempDir("openclaw-prune-docker-sdk-");
    const write = (name: string, value: unknown) => {
      const target = path.join(rootDir, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
    };
    write("package.json", {
      files: [
        "dist/**",
        "!dist/extensions/kept/**",
        "!dist/extensions/omitted/**",
        "!dist/extensions/node_modules/**",
      ],
    });
    for (const id of ["kept", "omitted"]) {
      const packageJson = { name: `@openclaw/${id}`, type: "module" };
      write(`extensions/${id}/package.json`, packageJson);
      write(`dist/extensions/${id}/package.json`, packageJson);
      write(
        `dist/extensions/${id}/index.js`,
        'export { value } from "openclaw/plugin-sdk/probe";\n',
      );
    }
    write("dist/extensions/node_modules/openclaw/package.json", {
      name: "openclaw",
      type: "module",
      exports: { "./plugin-sdk/probe": "./plugin-sdk/probe.js" },
    });
    write(
      "dist/extensions/node_modules/openclaw/plugin-sdk/probe.js",
      'export const value = "retained SDK";\n',
    );

    pruneDockerPluginDist({ cwd: rootDir, env: { OPENCLAW_EXTENSIONS: "kept" } });

    expect(fs.existsSync(path.join(rootDir, "extensions/omitted"))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, "dist/extensions/omitted"))).toBe(false);
    const entry = pathToFileURL(path.join(rootDir, "dist/extensions/kept/index.js")).href;
    expect(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "process.stdout.write((await import(process.argv[1])).value)",
          entry,
        ],
        { encoding: "utf8", timeout: 10_000 },
      ),
    ).toBe("retained SDK");
  });

  it("refuses to prune plugin trees through a symlinked dist root", () => {
    const rootDir = createTempDir("openclaw-prune-docker-dist-symlink-");
    const targetDir = path.join(rootDir, "gateway-dist");
    const pluginFile = path.join(targetDir, "extensions", "telegram", "index.js");
    fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
    fs.writeFileSync(pluginFile, "export {};\n");
    const distLink = path.join(rootDir, "dist");
    fs.symlinkSync(targetDir, distLink, "dir");

    expect(() => pruneDockerPluginDist({ cwd: rootDir, env: {} })).toThrow(/symbolic link/u);

    expect(fs.readlinkSync(distLink)).toBe(targetDir);
    expect(fs.readFileSync(pluginFile, "utf8")).toBe("export {};\n");
  });
});
