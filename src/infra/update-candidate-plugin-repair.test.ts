import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCommandBuffered } from "../process/exec.js";
import { resolveUpdateCandidatePluginPath } from "./update-candidate-paths.js";
import { completeUpdateCandidatePluginRehearsal } from "./update-candidate-plugin-repair.js";
import { buildUpdateRehearsalPathEnv } from "./update-rehearsal-paths.js";
import { buildUpdateDoctorEnv } from "./update-runner-doctor.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

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
  const write = async (file: string, content: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  };
  await write(path.join(candidateRoot, "package.json"), '{"name":"openclaw"}');
  await write(
    path.join(plugin, "package.json"),
    JSON.stringify({
      name: "demo",
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    }),
  );
  await write(
    path.join(plugin, "openclaw.plugin.json"),
    JSON.stringify({
      id: "demo",
      configSchema: { type: "object", properties: {} },
      ...(surface === "doctor" ? { doctorContract: { configRepair: true } } : {}),
    }),
  );
  await write(
    path.join(plugin, "index.mjs"),
    'import value from "../shared/value.js"; console.log(value);',
  );
  await write(path.join(shared, "package.json"), '{"type":"module"}');
  await write(path.join(shared, "value.js"), 'export { default } from "./nested/value.mjs";');
  await write(path.join(shared, "nested", "value.mjs"), 'export default "sibling-ready";');
  await write(path.join(shared, "unrelated.txt"), "not a module dependency");
  if (surface === "doctor") {
    await write(path.join(plugin, "index.mjs"), 'export default { id: "demo", register() {} };');
    await write(
      path.join(plugin, "doctor-contract-api.mjs"),
      'import value from "../shared/value.js"; console.log(value); export const legacyConfigRules = [];',
    );
  }
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
  return { root, plugin, shared, copiedPlugin, copiedShared, config, env, candidateRoot, run };
}

it.each(["directory", "file", "alias", "install-record"] as const)(
  "completes a released rehearsal's %s plugin without changing existing files",
  async (locatorKind) => {
    const f = await fixture(locatorKind);
    const entry = path.join(f.plugin, "index.mjs");
    const original = await fs.readFile(entry);
    const copied = await fs.readFile(path.join(f.copiedPlugin, "index.mjs"));
    const before = await f.run();
    expect(before.code).not.toBe(0);
    expect(before.stderr.toString()).toContain("ERR_MODULE_NOT_FOUND");

    const repaired = await completeUpdateCandidatePluginRehearsal(f);
    expect(repaired.copiedFiles).toBeGreaterThan(0);
    expect(await fs.readFile(entry)).toEqual(original);
    expect(await fs.readFile(path.join(f.copiedPlugin, "index.mjs"))).toEqual(copied);
    const plugins = path.dirname(f.plugin);
    const hidden = path.join(f.root, "source-unavailable");
    await fs.rename(plugins, hidden);
    try {
      expect((await completeUpdateCandidatePluginRehearsal(f)).copiedFiles).toBe(0);
      const after = await f.run();
      expect(after.code, after.stderr.toString()).toBe(0);
      expect(after.stdout.toString().trim()).toBe("sibling-ready");
    } finally {
      await fs.rename(hidden, plugins);
    }
    await expect(fs.access(path.join(f.copiedShared, "unrelated.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const repeated = await completeUpdateCandidatePluginRehearsal(f);
    expect(repeated.copiedFiles).toBe(0);
  },
);

it("completes a declared Doctor module independently of the runtime entry", async () => {
  const f = await fixture("directory", "doctor");
  const before = await f.run();
  expect(before.code).not.toBe(0);
  expect(before.stderr.toString()).toContain("ERR_MODULE_NOT_FOUND");
  expect((await completeUpdateCandidatePluginRehearsal(f)).copiedFiles).toBeGreaterThan(0);
  const after = await f.run();
  expect(after.code, after.stderr.toString()).toBe(0);
  expect(after.stdout.toString().trim()).toBe("sibling-ready");
});

it.each(["absolute path", "file URL"])(
  "retains an explicit external %s import in an already complete snapshot",
  async (kind) => {
    const f = await fixture();
    const sharedEntry = path.join(f.shared, "value.js");
    const specifier = kind === "file URL" ? pathToFileURL(sharedEntry).href : sharedEntry;
    const content = `import value from ${JSON.stringify(specifier)}; console.log(value);`;
    await fs.writeFile(path.join(f.plugin, "index.mjs"), content);
    await fs.writeFile(path.join(f.copiedPlugin, "index.mjs"), content);
    const before = await f.run();
    expect(before.code, before.stderr.toString()).toBe(0);
    expect(before.stdout.toString().trim()).toBe("sibling-ready");

    expect((await completeUpdateCandidatePluginRehearsal(f)).copiedFiles).toBe(0);
    const after = await f.run();
    expect(after.code, after.stderr.toString()).toBe(0);
    expect(after.stdout.toString().trim()).toBe("sibling-ready");
    expect(await fs.readFile(path.join(f.copiedPlugin, "index.mjs"), "utf8")).toBe(content);
  },
);

it.each(["new unrelated import", "invalid source"])(
  "leaves a runnable optional-import snapshot independent of %s edits",
  async (change) => {
    const f = await fixture();
    const content = [
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
      'try { require("#optional"); } catch { console.log("optional-fallback"); }',
    ].join("\n");
    const original =
      change === "invalid source" ? "invalid source {{{" : `${content}\nimport "./new-source.mjs";`;
    await fs.writeFile(path.join(f.plugin, "index.mjs"), original);
    await fs.writeFile(path.join(f.plugin, "new-source.mjs"), "export const newSource = true;");
    await fs.writeFile(path.join(f.copiedPlugin, "index.mjs"), content);
    const before = await f.run();
    expect(before.code, before.stderr.toString()).toBe(0);
    expect(before.stdout.toString().trim()).toBe("optional-fallback");

    expect((await completeUpdateCandidatePluginRehearsal(f)).copiedFiles).toBe(0);
    const after = await f.run();
    expect(after.code, after.stderr.toString()).toBe(0);
    expect(after.stdout.toString().trim()).toBe("optional-fallback");
    expect(await fs.readFile(path.join(f.copiedPlugin, "index.mjs"), "utf8")).toBe(content);
    expect(await fs.readFile(path.join(f.plugin, "index.mjs"), "utf8")).toBe(original);
    await expect(fs.access(path.join(f.copiedPlugin, "new-source.mjs"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("preserves staged bundled aliases while completing an external plugin", async () => {
  const f = await fixture();
  const bundled = path.join(f.candidateRoot, "dist", "extensions", "staged");
  await fs.mkdir(bundled, { recursive: true });
  await fs.writeFile(
    path.join(bundled, "package.json"),
    JSON.stringify({ name: "staged", openclaw: { extensions: ["./index.mjs"] } }),
  );
  await fs.writeFile(
    path.join(bundled, "openclaw.plugin.json"),
    JSON.stringify({ id: "staged", configSchema: { type: "object", properties: {} } }),
  );
  const stagedBytes = 'export default { id: "staged", register() {} };';
  await fs.writeFile(path.join(bundled, "index.mjs"), stagedBytes);
  f.config.plugins!.load!.paths!.push(bundled);
  const pathsBefore = [...f.config.plugins!.load!.paths!];

  expect((await completeUpdateCandidatePluginRehearsal(f)).copiedFiles).toBeGreaterThan(0);
  const after = await f.run();
  expect(after.code, after.stderr.toString()).toBe(0);
  expect(after.stdout.toString().trim()).toBe("sibling-ready");
  expect(f.config.plugins!.load!.paths).toEqual(pathsBefore);
  expect(await fs.readFile(path.join(bundled, "index.mjs"), "utf8")).toBe(stagedBytes);
});

it.each(["ordinary doctor", "lint", "incomplete rehearsal"])(
  "does not acquire source files for %s",
  async (kind) => {
    const f = await fixture();
    if (kind === "ordinary doctor") {
      f.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = "2026.9.4";
    } else if (kind === "lint") {
      f.env.OPENCLAW_UPDATE_IN_PROGRESS = "0";
    } else {
      delete f.env.OPENCLAW_SKIP_CHANNELS;
    }
    expect((await completeUpdateCandidatePluginRehearsal(f)).copiedFiles).toBe(0);
    await expect(fs.access(f.copiedShared)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("reports an unresolved dependency whose published projection lost the original path", async () => {
  const f = await fixture();
  const managed = path.join(f.env.OPENCLAW_STATE_DIR!, "extensions", "demo");
  await fs.mkdir(path.dirname(managed), { recursive: true });
  await fs.rename(f.copiedPlugin, managed);
  f.config.plugins!.load!.paths = [managed];

  const result = await completeUpdateCandidatePluginRehearsal(f);
  expect(result.copiedFiles).toBe(0);
  expect(result.warnings).toContain(
    `Update checks could not recover the original plugin path for ${path.join(managed, "index.mjs")}.`,
  );
  await expect(fs.access(path.join(path.dirname(managed), "shared"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each(["globally disabled", "disabled entry", "denied", "allowlisted elsewhere"])(
  "does not parse a malformed %s plugin",
  async (kind) => {
    const f = await fixture();
    await fs.writeFile(path.join(f.copiedPlugin, "index.mjs"), "not valid JavaScript {{{");
    f.config.plugins = {
      ...f.config.plugins,
      ...(kind === "globally disabled" ? { enabled: false } : {}),
      ...(kind === "disabled entry" ? { entries: { demo: { enabled: false } } } : {}),
      ...(kind === "denied" ? { deny: ["demo"] } : {}),
      ...(kind === "allowlisted elsewhere" ? { allow: ["another"] } : {}),
    };
    expect((await completeUpdateCandidatePluginRehearsal(f)).copiedFiles).toBe(0);
    await expect(fs.access(f.copiedShared)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("stops if repair authority ends during asynchronous source preparation", async () => {
  const f = await fixture();
  const pending = completeUpdateCandidatePluginRehearsal(f);
  f.env.OPENCLAW_UPDATE_IN_PROGRESS = "0";
  await expect(pending).rejects.toThrow("authority changed");
  await expect(fs.access(f.copiedShared)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["index.mjs", "package.json", "openclaw.plugin.json"])(
  "refuses an original %s changed since the published snapshot",
  async (filename) => {
    const f = await fixture();
    await fs.appendFile(path.join(f.plugin, filename), "\n ");
    await expect(completeUpdateCandidatePluginRehearsal(f)).rejects.toThrow(
      "changed since the update snapshot",
    );
    await expect(fs.access(f.copiedShared)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("preserves a conflicting existing dependency instead of replacing it", async () => {
  const f = await fixture();
  const conflicting = path.join(f.copiedShared, "value.js");
  await fs.mkdir(f.copiedShared, { recursive: true });
  const privateContent = 'export { default } from "./nested/value.mjs"; // private changes\n';
  await fs.writeFile(conflicting, privateContent);
  await expect(completeUpdateCandidatePluginRehearsal(f)).rejects.toThrow(
    "changed since the update snapshot",
  );
  expect(await fs.readFile(conflicting, "utf8")).toBe(privateContent);
});

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
          path.join(f.copiedPlugin, "index.mjs"),
          `import value from ${JSON.stringify(specifier)}; console.log(value);`,
        );
      }
    } else {
      const modules = path.join(f.copiedPlugin, "node_modules");
      await fs.mkdir(modules);
      await fs.symlink(f.shared, path.join(modules, "proof-shared"), "junction");
      await fs.writeFile(
        path.join(f.copiedPlugin, "index.mjs"),
        'import value from "proof-shared/value.js"; console.log(value);',
      );
    }
    const original = await fs.readFile(path.join(f.shared, "value.js"));
    await expect(completeUpdateCandidatePluginRehearsal(f)).rejects.toThrow(
      "outside the temporary update copy",
    );
    expect(await fs.readFile(path.join(f.shared, "value.js"))).toEqual(original);
  },
);
