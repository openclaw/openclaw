import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCommandBuffered } from "../process/exec.js";
import { resolveUpdateCandidatePluginPath } from "./update-candidate-paths.js";
import { completeUpdateCandidatePluginRehearsal } from "./update-candidate-plugin-repair.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import { materializeUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";
import { buildUpdateRehearsalPathEnv } from "./update-rehearsal-paths.js";
import { buildUpdateDoctorEnv } from "./update-runner-doctor.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

async function write(file: string, content: string | object) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
}

async function writeTree(root: string, files: Record<string, string | object>) {
  for (const [name, content] of Object.entries(files)) {
    await write(path.join(root, name), content);
  }
}

async function expectMissing(file: string) {
  await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectOutput(
  run: () => ReturnType<typeof runCommandBuffered>,
  output = "sibling-ready",
) {
  const result = await run();
  expect(result.code, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString().trim()).toBe(output);
}

async function fixture(
  locatorKind: "directory" | "file" | "alias" | "install-record" = "directory",
  surface: "runtime" | "doctor" = "runtime",
) {
  const root = dirs.make("candidate-plugin-repair-");
  const sourceState = path.join(root, "serving-state");
  const stateDir = path.join(root, "rehearsal");
  const candidateRoot = path.join(root, "candidate");
  const plugin = path.join(root, "plugins", "demo");
  const shared = path.join(root, "plugins", "shared");
  const siblingImport = 'import value from "../shared/value.js"; console.log(value);';
  await write(path.join(candidateRoot, "package.json"), '{"name":"openclaw"}');
  await writeTree(plugin, {
    "package.json": '{"name":"demo","type":"module","openclaw":{"extensions":["./index.mjs"]}}',
    "openclaw.plugin.json": {
      id: "demo",
      configSchema: { type: "object", properties: {} },
      ...(surface === "doctor" ? { doctorContract: { configRepair: true } } : {}),
    },
    "index.mjs":
      surface === "doctor" ? 'export default { id: "demo", register() {} };' : siblingImport,
    ...(surface === "doctor"
      ? { "doctor-contract-api.mjs": `${siblingImport} export const legacyConfigRules = [];` }
      : {}),
  });
  await writeTree(shared, {
    "package.json": '{"type":"module"}',
    "value.js": 'export { default } from "./nested/value.mjs";',
    "nested/value.mjs": 'export default "sibling-ready";',
    "unrelated.txt": "not a module dependency",
  });
  const copiedPlugin = resolveUpdateCandidatePluginPath(sourceState, stateDir, plugin);
  const copiedShared = resolveUpdateCandidatePluginPath(sourceState, stateDir, shared);
  // Released 9.4 copied the selected package but omitted this relative sibling.
  await fs.cp(plugin, copiedPlugin, { recursive: true });
  let locator = locatorKind === "file" ? path.join(copiedPlugin, "index.mjs") : copiedPlugin;
  if (locatorKind === "alias") {
    locator = path.join(stateDir, "selected-demo");
    await fs.symlink(copiedPlugin, locator, "junction");
  }
  const config: OpenClawConfig = {
    plugins:
      locatorKind === "install-record"
        ? { installs: { demo: { source: "path", sourcePath: locator, installPath: locator } } }
        : { load: { paths: [locator] } },
  };
  const env = {
    ...buildUpdateRehearsalPathEnv(stateDir),
    ...buildUpdateDoctorEnv({
      allowGatewayServiceRepair: false,
      allowGatewayActivation: false,
      serviceRepairPolicy: "external",
      deferConfiguredPluginInstallRepair: true,
    }),
  };
  const run = () =>
    runCommandBuffered(
      [
        process.execPath,
        path.join(copiedPlugin, surface === "doctor" ? "doctor-contract-api.mjs" : "index.mjs"),
      ],
      { timeoutMs: 10_000, cwd: root },
    );
  const candidate = { config, env, candidateRoot };
  return {
    ...candidate,
    root,
    plugin,
    shared,
    copiedPlugin,
    copiedShared,
    run,
    sourceEntry: path.join(plugin, "index.mjs"),
    copiedEntry: path.join(copiedPlugin, "index.mjs"),
    repair: () => completeUpdateCandidatePluginRehearsal(candidate),
  };
}

it.each(["directory", "file", "alias", "install-record"] as const)(
  "completes a released rehearsal's %s plugin without changing existing files",
  async (locatorKind) => {
    const f = await fixture(locatorKind);
    const entry = f.sourceEntry;
    const original = await fs.readFile(entry);
    const copied = await fs.readFile(f.copiedEntry);
    const before = await f.run();
    expect(before.code).not.toBe(0);
    expect(before.stderr.toString()).toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
    expect(before.stderr.toString()).toContain("shared/value.js");

    expect((await f.repair()).copiedFiles).toBeGreaterThan(0);
    expect(await fs.readFile(entry)).toEqual(original);
    expect(await fs.readFile(f.copiedEntry)).toEqual(copied);
    const plugins = path.dirname(f.plugin);
    const hidden = path.join(f.root, "source-unavailable");
    await fs.rename(plugins, hidden);
    try {
      expect((await f.repair()).copiedFiles).toBe(0);
      await expectOutput(f.run);
    } finally {
      await fs.rename(hidden, plugins);
    }
    await expectMissing(path.join(f.copiedShared, "unrelated.txt"));
    expect((await f.repair()).copiedFiles).toBe(0);
  },
);

it.each(["runtime", "doctor"] as const)(
  "completes the %s entry with transformed runtime syntax at line 1203",
  async (surface) => {
    const f = await fixture("directory", surface);
    const content =
      surface === "runtime"
        ? `import value from "../shared/value.js";\n${"\n".repeat(1201)}const module1=import.meta;\nconsole.log(value);`
        : `${"\n".repeat(1202)}const module1=/(/;`;
    await fs.writeFile(f.sourceEntry, content);
    await fs.writeFile(f.copiedEntry, content);
    const repaired = await f.repair();
    expect(repaired.copiedFiles).toBeGreaterThan(0);
    expect(repaired.warnings).toEqual(
      surface === "runtime"
        ? []
        : [expect.stringMatching(/plugin demo .*Invalid regular expression:.*\(1203:17\)/)],
    );
    await expectOutput(f.run);
  },
);

it.each(["external file URL", "invalid optional source"])(
  "preserves a runnable snapshot with %s",
  async (kind) => {
    const f = await fixture();
    const optional = kind === "invalid optional source";
    const content = optional
      ? [
          'import { createRequire } from "node:module";',
          "const require = createRequire(import.meta.url);",
          'try { require("#optional"); } catch { console.log("optional-fallback"); }',
        ].join("\n")
      : `import value from ${JSON.stringify(pathToFileURL(path.join(f.shared, "value.js")).href)}; console.log(value);`;
    const original = optional ? "invalid source {{{" : content;
    const output = optional ? "optional-fallback" : "sibling-ready";
    await fs.writeFile(f.sourceEntry, original);
    if (optional) {
      await fs.writeFile(path.join(f.plugin, "new-source.mjs"), "export const newSource = true;");
    }
    await fs.writeFile(f.copiedEntry, content);
    await expectOutput(f.run, output);
    expect((await f.repair()).copiedFiles).toBe(0);
    await expectOutput(f.run, output);
    expect(await fs.readFile(f.copiedEntry, "utf8")).toBe(content);
    expect(await fs.readFile(f.sourceEntry, "utf8")).toBe(original);
    if (optional) {
      await expectMissing(path.join(f.copiedPlugin, "new-source.mjs"));
    }
  },
);

it("preserves staged bundled aliases while completing an external plugin", async () => {
  const f = await fixture();
  const bundled = path.join(f.candidateRoot, "dist", "extensions", "staged");
  const stagedBytes = 'export default { id: "staged", register() {} };';
  await writeTree(bundled, {
    "package.json": { name: "staged", openclaw: { extensions: ["./index.mjs"] } },
    "openclaw.plugin.json": { id: "staged", configSchema: { type: "object", properties: {} } },
    "index.mjs": stagedBytes,
  });
  f.config.plugins!.load!.paths!.push(bundled);
  const pathsBefore = [...f.config.plugins!.load!.paths!];

  expect((await f.repair()).copiedFiles).toBeGreaterThan(0);
  await expectOutput(f.run);
  expect(f.config.plugins!.load!.paths).toEqual(pathsBefore);
  expect(await fs.readFile(path.join(bundled, "index.mjs"), "utf8")).toBe(stagedBytes);
});

it.each(["lint", "incomplete rehearsal"])("does not acquire source files for %s", async (kind) => {
  const f = await fixture();
  if (kind === "lint") {
    f.env.OPENCLAW_UPDATE_IN_PROGRESS = "0";
  } else {
    delete f.env.OPENCLAW_SKIP_CHANNELS;
  }
  expect((await f.repair()).copiedFiles).toBe(0);
  await expectMissing(f.copiedShared);
});

it("reports an unresolved dependency whose published projection lost the original path", async () => {
  const f = await fixture();
  const managed = path.join(f.env.OPENCLAW_STATE_DIR!, "extensions", "demo");
  await fs.mkdir(path.dirname(managed), { recursive: true });
  await fs.rename(f.copiedPlugin, managed);
  f.config.plugins!.load!.paths = [managed];

  const result = await f.repair();
  expect(result.copiedFiles).toBe(0);
  expect(result.warnings).toContain(
    `Update checks could not recover the original plugin path for ${path.join(managed, "index.mjs")}.`,
  );
  await expectMissing(path.join(path.dirname(managed), "shared"));
});

it.each([
  { name: "globally disabled", policy: { enabled: false } },
  { name: "disabled entry", policy: { entries: { demo: { enabled: false } } } },
  { name: "denied", policy: { deny: ["demo"] } },
  { name: "allowlisted elsewhere", policy: { allow: ["another"] } },
])("does not parse a malformed $name plugin", async ({ policy }) => {
  const f = await fixture();
  await fs.writeFile(f.copiedEntry, "not valid JavaScript {{{");
  f.config.plugins = { ...f.config.plugins, ...policy };
  expect((await f.repair()).copiedFiles).toBe(0);
  await expectMissing(f.copiedShared);
});

it("preserves a conflicting existing dependency instead of replacing it", async () => {
  const f = await fixture();
  const conflicting = path.join(f.copiedShared, "value.js");
  await fs.mkdir(f.copiedShared, { recursive: true });
  const privateContent = 'export { default } from "./nested/value.mjs"; // private changes\n';
  await fs.writeFile(conflicting, privateContent);
  expect((await f.repair()).copiedFiles).toBeGreaterThan(0);
  expect(await fs.readFile(conflicting, "utf8")).toBe(privateContent);
  await expectOutput(f.run);
});

it.each(["undeclared", "dependencies"])(
  "isolates an ancestor package lookup with %s metadata during published-driver rehearsal",
  async (declaration) => {
    const f = await fixture();
    const name = "rehearsal-optional-vendor";
    const ancestor = path.join(f.root, "node_modules", name);
    await writeTree(ancestor, {
      "package.json": { name, main: "index.cjs" },
      "index.cjs": "module.exports = 'foreign';",
    });
    const vendor = path.join(f.copiedPlugin, "node_modules", "vendor");
    await writeTree(vendor, {
      "package.json": {
        name: "vendor",
        main: "index.cjs",
        ...(declaration === "undeclared" ? {} : { [declaration]: { [name]: "1.0.0" } }),
      },
      "index.cjs": `exports.optional = () => { try { return require(${JSON.stringify(name)}); } catch { return 'fallback'; } };`,
    });
    await fs.writeFile(f.copiedEntry, 'import "vendor";');

    if (declaration !== "undeclared") {
      await expect(f.repair()).rejects.toThrow("outside the temporary update copy");
      return;
    }
    const result = await f.repair();
    expect(result.copiedFiles).toBe(0);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        `Plugin dependency ${name} is unresolvable inside the temporary update copy`,
      ),
    ]);
    // Rehearsal inspection must never acquire or parse unrelated ancestor source.
    await fs.writeFile(path.join(ancestor, "index.cjs"), "invalid JavaScript {{{");
    expect(await f.repair()).toEqual(result);

    const internal = path.join(vendor, "node_modules", name);
    await fs.mkdir(internal, { recursive: true });
    await fs.copyFile(path.join(ancestor, "package.json"), path.join(internal, "package.json"));
    await fs.writeFile(path.join(internal, "index.cjs"), "module.exports = 'private';");
    expect(await f.repair()).toEqual({ copiedFiles: 0, warnings: [] });
  },
);

it.each(["relative", "package", "absolute", "file URL"])(
  "never follows a private %s dependency link into the serving tree",
  async (kind) => {
    const f = await fixture();
    if (kind !== "package") {
      await fs.symlink(f.shared, f.copiedShared, "junction");
      if (kind !== "relative") {
        const target = path.join(f.copiedShared, "value.js");
        const specifier = kind === "file URL" ? pathToFileURL(target).href : target;
        await fs.writeFile(
          f.copiedEntry,
          `import value from ${JSON.stringify(specifier)}; console.log(value);`,
        );
      }
    } else {
      const modules = path.join(f.copiedPlugin, "node_modules");
      await fs.mkdir(modules);
      await fs.symlink(f.shared, path.join(modules, "proof-shared"), "junction");
      await fs.writeFile(
        f.copiedEntry,
        'import value from "proof-shared/value.js"; console.log(value);',
      );
    }
    const original = await fs.readFile(path.join(f.shared, "value.js"));
    await expect(f.repair()).rejects.toThrow("outside the temporary update copy");
    expect(await fs.readFile(path.join(f.shared, "value.js"))).toEqual(original);
  },
);

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
    const writeSource = (file: string, content: string | object) =>
      write(path.join(repository, file), content);
    await writeSource("package.json", { type: "module" });
    await writeSource("unrelated.txt", "not a plugin dependency");
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
      await writeSource("plugin/mapped.mjs", 'export { default } from "../shared/value.js";');
    } else if (workspace) {
      importTarget = commonjs ? "sibling-helper/lib/value" : "sibling-helper";
      const helper = path.join(repository, "helper");
      await fs.mkdir(path.join(helper, "lib"), { recursive: true });
      await writeSource("helper/package.json", {
        name: "sibling-helper",
        ...(commonjs ? {} : { type: "module", exports: "./index.mjs" }),
      });
      await writeSource(
        `helper/${commonjs ? "lib/value.js" : "index.mjs"}`,
        commonjs
          ? 'module.exports = require("../../shared/value.cjs");'
          : 'export { default } from "../shared/value.js";',
      );
      await fs.mkdir(path.join(plugin, "node_modules"));
      await fs.symlink(helper, path.join(plugin, "node_modules", "sibling-helper"), "junction");
    }
    await writeSource("plugin/package.json", {
      name: "demo",
      type: "module",
      openclaw: { extensions: [`./${basename}`] },
      ...(syntax === "package-map" ? { imports: { "#helper": "./mapped.mjs" } } : {}),
      ...(workspace ? { dependencies: { "sibling-helper": "1.0.0" } } : {}),
    });
    await writeSource("plugin/openclaw.plugin.json", {
      id: "demo",
      configSchema: { type: "object" },
    });
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
      await expectOutput(
        () =>
          runCommandBuffered([process.execPath, "--input-type=module", "-e", expression], {
            timeoutMs: 10_000,
          }),
        "shared source survived",
      );
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
      await expectMissing(path.resolve(path.dirname(copiedEntry), "..", "unrelated.txt"));
    } finally {
      await rehearsal.cleanup();
    }
  },
);
