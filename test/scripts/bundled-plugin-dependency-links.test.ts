import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { linkSourcePluginDependencies } from "../../scripts/lib/bundled-plugin-dependency-links.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("linkSourcePluginDependencies", () => {
  it.each([true, false])("preserves plugin dependencies (checkout host: %s)", (checkoutHost) => {
    const root = fs.realpathSync(createTempDir("openclaw-plugin-dependency-links-"));
    const plugin = path.join(root, "extensions", "x");
    const modules = path.join(plugin, "node_modules");
    const destination = path.join(root, "dist", "extensions", "x", "node_modules");
    const host = checkoutHost ? root : path.join(root, "installed", "openclaw");
    fs.mkdirSync(modules, { recursive: true });
    for (const [name, target] of [
      ["openclaw", host],
      ["ancestor-alias", root],
      ["@fixture/dependency", path.join(root, "payload")],
      [".bin", path.join(root, "launchers")],
    ] as const) {
      fs.mkdirSync(target, { recursive: true });
      fs.mkdirSync(path.dirname(path.join(modules, name)), { recursive: true });
      fs.symlinkSync(target, path.join(modules, name), "junction");
    }
    fs.writeFileSync(path.join(root, "payload", "index.cjs"), "module.exports = 'dependency';");
    linkSourcePluginDependencies(plugin, destination);
    expect(fs.existsSync(path.join(destination, "openclaw"))).toBe(!checkoutHost);
    if (!checkoutHost) {
      expect(fs.realpathSync(path.join(destination, "openclaw"))).toBe(host);
    }
    expect(fs.existsSync(path.join(destination, "ancestor-alias"))).toBe(false);
    expect(fs.realpathSync(path.join(destination, "@fixture", "dependency"))).toBe(
      path.join(root, "payload"),
    );
    expect(fs.realpathSync(path.join(destination, ".bin"))).toBe(path.join(root, "launchers"));
  });
});
