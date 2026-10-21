import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCommandBuffered } from "../process/exec.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import { materializeUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";

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
    await materializeUpdateCandidateStateWorker(root);
    const repository = path.join(root, "repository");
    const plugin = path.join(repository, "plugin");
    const shared = path.join(repository, "shared");
    await fs.mkdir(plugin, { recursive: true });
    await fs.mkdir(shared);
    const write = (file: string, content: string | object) =>
      fs.writeFile(
        path.join(repository, file),
        typeof content === "string" ? content : JSON.stringify(content),
      );
    await write("package.json", { type: "module" });
    await write("unrelated.txt", "not a plugin dependency");
    const commonjs = syntax === "require" || syntax === "require-package-subpath";
    const workspace = syntax === "workspace-dependency" || syntax === "require-package-subpath";
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
      await write("plugin/mapped.mjs", 'export { default } from "../shared/value.js";');
    } else if (workspace) {
      importTarget = commonjs ? "sibling-helper/lib/value" : "sibling-helper";
      const helper = path.join(repository, "helper");
      await fs.mkdir(path.join(helper, "lib"), { recursive: true });
      await write("helper/package.json", {
        name: "sibling-helper",
        ...(commonjs ? {} : { type: "module", exports: "./index.mjs" }),
      });
      await write(
        `helper/${commonjs ? "lib/value.js" : "index.mjs"}`,
        commonjs
          ? 'module.exports = require("../../shared/value.cjs");'
          : 'export { default } from "../shared/value.js";',
      );
      await fs.mkdir(path.join(plugin, "node_modules"));
      await fs.symlink(helper, path.join(plugin, "node_modules", "sibling-helper"), "junction");
    }
    await write("plugin/package.json", {
      name: "demo",
      type: "module",
      openclaw: { extensions: [`./${basename}`] },
      ...(syntax === "package-map" ? { imports: { "#helper": "./mapped.mjs" } } : {}),
      ...(workspace ? { dependencies: { "sibling-helper": "1.0.0" } } : {}),
    });
    await write("plugin/openclaw.plugin.json", { id: "demo", configSchema: { type: "object" } });
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
    const expectExecutable = async (file: string) => {
      const expression = `console.log(await (await import(${JSON.stringify(pathToFileURL(file).href)})).default())`;
      const result = await runCommandBuffered(
        [process.execPath, "--input-type=module", "-e", expression],
        { timeoutMs: 10_000 },
      );
      expect(result.code, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString().trim()).toBe("shared source survived");
    };
    await expectExecutable(entry);
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
      await expectExecutable(copiedEntry);
      await expect(
        fs.access(path.resolve(path.dirname(copiedEntry), "..", "unrelated.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rehearsal.cleanup();
    }
  },
);
