import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolvePluginNpmGenerationProjectDir } from "../plugins/install-paths.js";
import * as installRecordsOwner from "../plugins/installed-plugin-index-records.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import {
  listPluginOpenClawHostLinkIssues,
  maybeRepairPluginOpenClawHostLinks,
} from "./doctor-plugin-host-links.js";
import {
  detectPluginRegistryHealthIssues,
  maybeRepairPluginRegistryState,
  pluginRegistryIssueToHealthFinding,
  pluginRegistryIssueToRepairEffect,
} from "./doctor-plugin-registry.js";
import { hermeticEnv } from "./doctor-plugin-registry.test-support.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function writeJson(dir: string, value: unknown, name = "package.json") {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(note).mockReset();
});

function makePlugin({
  stateDir = tempDirs.make("openclaw-doctor-plugin-host-links-"),
  pluginId = "email",
  packageDir = path.join(stateDir, "extensions", pluginId),
}: {
  stateDir?: string;
  pluginId?: string;
  packageDir?: string;
} = {}) {
  const staleHostDir = path.join(packageDir, "node_modules", "openclaw");
  fs.mkdirSync(staleHostDir, { recursive: true });
  writeJson(packageDir, {
    name: `@clawemail/${pluginId}`,
    version: "2026.7.1",
    peerDependencies: { openclaw: ">=2026.7.1" },
    openclaw: { extensions: ["./index.js"] },
  });
  fs.writeFileSync(path.join(packageDir, "index.js"), "export default {};\n");
  writeJson(packageDir, { id: pluginId, configSchema: { type: "object" } }, "openclaw.plugin.json");
  writeJson(staleHostDir, { name: "openclaw", version: "2026.7.1-beta.2" });
  return { stateDir, packageDir, staleHostDir };
}

async function writeInstallRecords(
  stateDir: string,
  installRecords: Record<string, PluginInstallRecord>,
): Promise<void> {
  await seedInstalledPluginIndex(installRecords, { stateDir, candidates: [] });
}

function doctorParams(stateDir: string, shouldRepair: boolean) {
  return {
    stateDir,
    env: hermeticEnv({ OPENCLAW_STATE_DIR: stateDir }),
    config: {},
    prompter: { shouldRepair },
  };
}

it("audits and repairs only the selected managed npm generations", async () => {
  const stateDir = tempDirs.make("openclaw-active-host-links-");
  const records: Record<string, PluginInstallRecord> = {};
  const activePackages: string[] = [];
  const stalePackages: string[] = [];
  for (const pluginId of ["first", "second"]) {
    const packageName = `@fixture/${pluginId}`;
    for (let generation = 0; generation <= 20; generation++) {
      const root = resolvePluginNpmGenerationProjectDir({
        npmDir: path.join(stateDir, "npm"),
        packageName,
        generationKey: String(generation),
      });
      const packageDir = path.join(root, "node_modules", ...packageName.split("/"));
      fs.mkdirSync(packageDir, { recursive: true });
      writeJson(root, { private: true, dependencies: { [packageName]: "1.0.0" } });
      writeJson(packageDir, {
        name: packageName,
        version: "1.0.0",
        peerDependencies: { openclaw: "*" },
      });
      if (generation === 0) {
        records[pluginId] = { source: "npm", installPath: packageDir, resolvedName: packageName };
        activePackages.push(packageDir);
      } else {
        stalePackages.push(packageDir);
      }
    }
  }
  await writeInstallRecords(stateDir, records);
  const reads = vi.spyOn(fs.promises, "readdir");
  const syncReads = vi.spyOn(fs, "readdirSync");
  const params = doctorParams(stateDir, false);
  const audit = await listPluginOpenClawHostLinkIssues(params);
  await maybeRepairPluginOpenClawHostLinks({ ...params, prompter: { shouldRepair: true } });

  expect(
    syncReads.mock.calls.some(([dir]) => String(dir) === path.join(stateDir, "npm", "projects")),
  ).toBe(false);

  expect(audit.peerLinkIssues.map((issue) => issue.packageDir).toSorted()).toEqual(
    activePackages.toSorted(),
  );
  for (const packageDir of activePackages) {
    expect(fs.realpathSync(path.join(packageDir, "node_modules", "openclaw"))).toBe(
      fs.realpathSync(process.cwd()),
    );
  }
  for (const packageDir of stalePackages) {
    expect(fs.existsSync(path.join(packageDir, "node_modules", "openclaw"))).toBe(false);
    expect(
      reads.mock.calls.some(([dir]) =>
        String(dir).startsWith(path.dirname(path.dirname(packageDir))),
      ),
    ).toBe(false);
  }
});

it("warns and falls back for unreadable records without swallowing invalid records", async () => {
  const stateDir = tempDirs.make("openclaw-host-record-failure-");
  const read = vi.spyOn(
    installRecordsOwner,
    "readPersistedInstalledPluginIndexInstallRecordsAsync",
  );
  const load = vi.spyOn(installRecordsOwner, "loadInstalledPluginIndexInstallRecords");
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  read.mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
  await expect(listPluginOpenClawHostLinkIssues({ stateDir })).resolves.toMatchObject({
    peerLinkIssues: [],
  });
  expect(warning).toHaveBeenCalledOnce();
  const invalid = new Error("Persisted plugin install records are invalid");
  read.mockResolvedValueOnce(null);
  load.mockRejectedValueOnce(invalid);
  await expect(listPluginOpenClawHostLinkIssues({ stateDir })).rejects.toBe(invalid);
  expect(warning).toHaveBeenCalledOnce();
});

it("relinks a cloned plugin without changing the source host link or package", async () => {
  const { stateDir: sourceState, packageDir, staleHostDir } = makePlugin();
  const clonedState = tempDirs.make("openclaw-cloned-plugin-host-");
  const oldHost = path.join(sourceState, "old-host");
  fs.renameSync(staleHostDir, oldHost);
  fs.symlinkSync(oldHost, staleHostDir, "junction");
  const sourceManifest = fs.readFileSync(path.join(packageDir, "package.json"));
  const hostManifest = fs.readFileSync(path.join(oldHost, "package.json"));
  const clonedPackage = path.join(clonedState, "extensions", "email");
  fs.cpSync(packageDir, clonedPackage, { recursive: true, verbatimSymlinks: true });
  await writeInstallRecords(clonedState, {
    email: { source: "clawhub", installPath: clonedPackage },
  });

  await maybeRepairPluginRegistryState(doctorParams(clonedState, true));

  expect(fs.realpathSync(path.join(clonedPackage, "node_modules", "openclaw"))).toBe(
    fs.realpathSync(process.cwd()),
  );
  expect(fs.readlinkSync(staleHostDir)).toBe(oldHost);
  expect(fs.readFileSync(path.join(packageDir, "package.json"))).toEqual(sourceManifest);
  expect(fs.readFileSync(path.join(oldHost, "package.json"))).toEqual(hostManifest);
});

it("reports a stale registered extensions-root host without changing it in read-only doctor", async () => {
  const { stateDir, packageDir, staleHostDir } = makePlugin();
  await writeInstallRecords(stateDir, { email: { source: "npm", installPath: packageDir } });

  const params = doctorParams(stateDir, false);
  const issues = await detectPluginRegistryHealthIssues(params);
  await maybeRepairPluginRegistryState(params);

  const issue = expectDefined(
    issues.find((entry) => entry.kind === "registered-npm-openclaw-host-link"),
    "registered host-link issue",
  );
  expect(issue).toMatchObject({ packageDir, packageName: "email" });
  expect(pluginRegistryIssueToHealthFinding(issue)).toMatchObject({
    checkId: "core/doctor/plugin-registry",
    path: packageDir,
    target: "email",
  });
  expect(pluginRegistryIssueToRepairEffect(issue)).toEqual({
    kind: "package",
    action: "would-relink-registered-npm-openclaw-host",
    target: packageDir,
    dryRunSafe: false,
  });
  expect(fs.lstatSync(staleHostDir).isDirectory()).toBe(true);
  expect(vi.mocked(note).mock.calls.join("\n")).toContain("email");
});

it.each([
  ["an external registry-owned install", "external-owner/email", "clawhub"],
  ["a developer-controlled path install", "extensions/email", "path"],
] as const)("does not repair %s", async (_name, relativePath, source) => {
  const stateDir = tempDirs.make("openclaw-doctor-plugin-host-links-");
  const { packageDir, staleHostDir } = makePlugin({
    stateDir,
    packageDir: path.join(stateDir, relativePath),
  });
  await writeInstallRecords(stateDir, {
    email: { source, installPath: packageDir },
  });

  await maybeRepairPluginRegistryState(doctorParams(stateDir, true));

  expect(fs.lstatSync(staleHostDir).isDirectory()).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(staleHostDir, "package.json"), "utf8"))).toEqual({
    name: "openclaw",
    version: "2026.7.1-beta.2",
  });
});

it.runIf(process.platform !== "win32").each([
  ["outside its owner root", "external-owner/email"],
  ["to a developer-owned sibling", "extensions/local-project"],
])("does not follow a registered package alias %s", async (_name, target) => {
  const stateDir = tempDirs.make("openclaw-doctor-plugin-host-links-");
  const targetDir = path.join(stateDir, target);
  const { staleHostDir } = makePlugin({ stateDir, packageDir: targetDir });
  const packageDir = path.join(stateDir, "extensions", "email");
  fs.mkdirSync(path.dirname(packageDir), { recursive: true });
  fs.symlinkSync(targetDir, packageDir, "dir");
  await writeInstallRecords(stateDir, { email: { source: "clawhub", installPath: packageDir } });

  await maybeRepairPluginRegistryState(doctorParams(stateDir, true));

  expect(fs.lstatSync(staleHostDir).isDirectory()).toBe(true);
});

it("reports a malformed registered package and still repairs its valid sibling", async () => {
  const broken = makePlugin({ pluginId: "broken" });
  const { stateDir } = broken;
  const email = makePlugin({ stateDir });
  fs.writeFileSync(path.join(broken.packageDir, "package.json"), "{", "utf8");
  await writeInstallRecords(stateDir, {
    broken: { source: "clawhub", installPath: broken.packageDir },
    email: { source: "clawhub", installPath: email.packageDir },
  });

  const issues = await detectPluginRegistryHealthIssues(doctorParams(stateDir, false));
  await maybeRepairPluginRegistryState(doctorParams(stateDir, true));

  for (const [kind, packageDir] of [
    ["registered-npm-package-unreadable", broken.packageDir],
    ["registered-npm-openclaw-host-link", email.packageDir],
  ]) {
    expect(issues).toContainEqual(expect.objectContaining({ kind, packageDir }));
  }
  expect(fs.lstatSync(broken.staleHostDir).isDirectory()).toBe(true);
  expect(fs.lstatSync(email.staleHostDir).isSymbolicLink()).toBe(true);
  expect(vi.mocked(note).mock.calls.join("\n")).toContain("Could not inspect registered");
});
it("repairs an archive plugin's dangling host link without its original archive", async () => {
  const { stateDir, packageDir, staleHostDir } = makePlugin();
  const removedHost = path.join(stateDir, "removed-host");
  fs.rmSync(staleHostDir, { recursive: true });
  fs.symlinkSync(removedHost, staleHostDir, "junction");
  const archivePath = path.join(path.dirname(packageDir), "email-original.tgz");
  await writeInstallRecords(stateDir, {
    email: { source: "archive", installPath: packageDir, sourcePath: archivePath },
  });
  const packageBytes = fs.readFileSync(path.join(packageDir, "package.json"));

  expect(fs.existsSync(archivePath)).toBe(false);
  expect(fs.existsSync(staleHostDir)).toBe(false);
  expect(fs.lstatSync(staleHostDir).isSymbolicLink()).toBe(true);

  await maybeRepairPluginRegistryState(doctorParams(stateDir, true));

  expect(fs.realpathSync(staleHostDir)).toBe(fs.realpathSync(process.cwd()));
  expect(fs.readFileSync(path.join(packageDir, "package.json"))).toEqual(packageBytes);
  expect(fs.existsSync(archivePath)).toBe(false);
  expect(fs.existsSync(removedHost)).toBe(false);
});
