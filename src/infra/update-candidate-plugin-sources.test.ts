import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCommandBuffered } from "../process/exec.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { syntax: "import", fileLocator: false },
  { syntax: "import", fileLocator: true },
  { syntax: "require", fileLocator: false },
  { syntax: "dynamic-import", fileLocator: false },
  { syntax: "package-map", fileLocator: false },
  { syntax: "workspace-dependency", fileLocator: false },
  { syntax: "require-package-subpath", fileLocator: false },
  { syntax: "optional-package-map", fileLocator: false },
])(
  "keeps imported sibling source files private ($syntax, file locator=$fileLocator)",
  async ({ syntax, fileLocator }) => {
    const root = await fs.realpath(dirs.make("candidate-plugin-sources-"));
    const repository = path.join(root, "repository");
    const plugin = path.join(repository, "plugin");
    const shared = path.join(repository, "shared");
    await fs.mkdir(plugin, { recursive: true });
    await fs.mkdir(shared);
    await fs.writeFile(path.join(repository, "package.json"), '{"type":"module"}');
    await fs.writeFile(path.join(repository, "unrelated.txt"), "not a plugin dependency");
    const commonjs = syntax === "require" || syntax === "require-package-subpath";
    const basename = commonjs ? "index.cjs" : "index.mjs";
    const dependency = path.join(shared, commonjs ? "value.cjs" : "value.js");
    const dependencyText = commonjs
      ? 'module.exports = "shared source survived";'
      : 'export default "shared source survived";';
    await fs.writeFile(dependency, dependencyText);
    const entry = path.join(plugin, basename);
    let importTarget = commonjs ? "../shared/value.cjs" : "../shared/value.js";
    if (syntax === "package-map") {
      importTarget = "#helper";
      await fs.writeFile(
        path.join(plugin, "mapped.mjs"),
        'export { default } from "../shared/value.js";',
      );
    } else if (syntax === "workspace-dependency" || syntax === "require-package-subpath") {
      importTarget = commonjs ? "sibling-helper/lib/value" : "sibling-helper";
      const helper = path.join(repository, "helper");
      await fs.mkdir(path.join(helper, "lib"), { recursive: true });
      await fs.writeFile(
        path.join(helper, "package.json"),
        JSON.stringify({
          name: "sibling-helper",
          ...(commonjs ? {} : { type: "module", exports: "./index.mjs" }),
        }),
      );
      await fs.writeFile(
        path.join(helper, commonjs ? "lib/value.js" : "index.mjs"),
        commonjs
          ? 'module.exports = require("../../shared/value.cjs");'
          : 'export { default } from "../shared/value.js";',
      );
      await fs.mkdir(path.join(plugin, "node_modules"));
      await fs.symlink(helper, path.join(plugin, "node_modules", "sibling-helper"), "junction");
    }
    await fs.writeFile(
      path.join(plugin, "package.json"),
      JSON.stringify({
        name: "demo",
        type: "module",
        openclaw: { extensions: [`./${basename}`] },
        ...(syntax === "package-map" ? { imports: { "#helper": "./mapped.mjs" } } : {}),
        ...(syntax === "workspace-dependency" || syntax === "require-package-subpath"
          ? { dependencies: { "sibling-helper": "1.0.0" } }
          : {}),
      }),
    );
    await fs.writeFile(
      path.join(plugin, "openclaw.plugin.json"),
      JSON.stringify({ id: "demo", configSchema: { type: "object", properties: {} } }),
    );
    await fs.writeFile(
      entry,
      commonjs
        ? `module.exports = () => require(${JSON.stringify(importTarget)});`
        : syntax === "dynamic-import"
          ? 'export default async () => (await import("../shared/value.js")).default;'
          : syntax === "optional-package-map"
            ? 'export default async () => { try { await import("#optional"); } catch { return "shared source survived"; } };'
            : `import value from ${JSON.stringify(importTarget)}; export default () => value;`,
    );
    const execute = (file: string) =>
      runCommandBuffered(
        [
          process.execPath,
          "--input-type=module",
          "-e",
          `console.log(await (await import(${JSON.stringify(pathToFileURL(file).href)})).default())`,
        ],
        { timeoutMs: 10_000 },
      );
    const before = await execute(entry);
    expect(before.code, before.stderr.toString()).toBe(0);
    expect(before.stdout.toString().trim()).toBe("shared source survived");
    const rehearsal = await prepareUpdateCandidateRehearsal({
      config: { plugins: { load: { paths: [fileLocator ? entry : plugin] } } },
      stateDir: path.join(root, "source-state"),
      candidateRoot: root,
    });
    try {
      const config: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
      const locator = config.plugins!.load!.paths![0]!;
      const copiedEntry = fileLocator ? locator : path.join(locator, basename);
      expect(await fs.readFile(dependency, "utf8")).toBe(dependencyText);
      // Removing the original tree makes a live-source fallback fail this proof.
      await fs.rename(repository, path.join(root, "retained-original"));
      const result = await execute(copiedEntry);
      expect(result.code, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString().trim()).toBe("shared source survived");
      await expect(
        fs.access(path.resolve(path.dirname(copiedEntry), "..", "unrelated.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rehearsal.cleanup();
    }
  },
);
