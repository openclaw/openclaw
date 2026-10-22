import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
    fs.writeFileSync(path.join(plugin, "package.json"), "{}");
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
    fs.writeFileSync(
      path.join(root, "payload", "package.json"),
      JSON.stringify({ main: "index.cjs" }),
    );
    linkSourcePluginDependencies(plugin, destination);
    expect(createRequire(path.join(destination, "..", "probe.cjs"))("@fixture/dependency")).toBe(
      "dependency",
    );
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
  it.each(["optionalDependencies", "peerDependenciesMeta"])(
    "warns for an unavailable declared optional dependency (%s), preserving usable siblings",
    (field) => {
      const root = fs.realpathSync(createTempDir("openclaw-optional-dependency-link-"));
      const plugin = path.join(root, "extensions/x");
      const modules = path.join(plugin, "node_modules");
      const destination = path.join(root, "dist/extensions/x/node_modules");
      fs.mkdirSync(modules, { recursive: true });
      fs.writeFileSync(
        path.join(plugin, "package.json"),
        JSON.stringify({
          [field]: { missing: field === "optionalDependencies" ? "1.0.0" : { optional: true } },
        }),
      );
      fs.symlinkSync(path.join(root, "absent"), path.join(modules, "missing"), "junction");
      fs.mkdirSync(path.join(modules, "usable"));
      fs.writeFileSync(path.join(modules, "usable/index.js"), "module.exports = 'usable';");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        linkSourcePluginDependencies(plugin, destination);
        expect(createRequire(path.join(destination, "..", "probe.cjs"))("usable")).toBe("usable");
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("optional dependency missing is unavailable"),
        );
      } finally {
        warn.mockRestore();
      }
      // The same missing payload is not optional without a manifest declaration.
      fs.rmSync(destination, { recursive: true, force: true });
      fs.writeFileSync(path.join(plugin, "package.json"), "{}");
      expect(() => linkSourcePluginDependencies(plugin, destination)).toThrow(/ENOENT/);
    },
  );

  it("does not hide unknown filesystem corruption for optional dependencies", () => {
    const root = fs.realpathSync(createTempDir("openclaw-invalid-dependency-link-"));
    const plugin = path.join(root, "extensions/x");
    const modules = path.join(plugin, "node_modules");
    fs.mkdirSync(modules, { recursive: true });
    fs.writeFileSync(
      path.join(plugin, "package.json"),
      JSON.stringify({ optionalDependencies: { cycle: "1" } }),
    );
    fs.symlinkSync("cycle", path.join(modules, "cycle"));
    expect(() =>
      linkSourcePluginDependencies(plugin, path.join(root, "dist/extensions/x/node_modules")),
    ).toThrow(/ELOOP/);
  });
});
