import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import {
  runPluginPayloadSmokeCheck,
  runPluginPayloadSmokeCheckForManifestRecords,
} from "./payload-verification.js";

type BundleFormat = "agent" | "codex" | "claude" | "cursor";
type FormatMarkedBundleInstallRecord = PluginInstallRecord & {
  format: "bundle";
  bundleFormat?: BundleFormat;
};

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-payload-smoke-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function checkPackage(pluginId: string, installPath: string) {
  return checkRecord(pluginId, { source: "npm", installPath });
}

function checkRecord(pluginId: string, record: PluginInstallRecord) {
  return runPluginPayloadSmokeCheck({ records: { [pluginId]: record }, env: {} });
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value), "utf8");
}

async function writePackage(dir: string, manifest: Record<string, unknown>, mainContent?: string) {
  await writeJson(path.join(dir, "package.json"), manifest);
  const main = typeof manifest.main === "string" ? manifest.main : "index.js";
  if (mainContent !== undefined) {
    const target = path.join(dir, main);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, mainContent, "utf8");
  }
}

function expectFailure(
  result: Awaited<ReturnType<typeof checkPackage>>,
  pluginId: string,
  installPath: string,
  reason: string,
  detail: string,
) {
  expect(result.failures).toStrictEqual([{ pluginId, installPath, reason, detail }]);
}

async function writeBundle(
  dir: string,
  format: BundleFormat,
  manifest?: unknown,
  markerOnly = false,
) {
  await fs.mkdir(path.join(dir, "skills"), { recursive: true });
  if (markerOnly) {
    return;
  }
  const manifestDir = {
    agent: "",
    codex: ".codex-plugin",
    cursor: ".cursor-plugin",
    claude: ".claude-plugin",
  }[format];
  await writeJson(
    path.join(dir, manifestDir, "plugin.json"),
    manifest ?? {
      ...(format === "agent"
        ? { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" }
        : {}),
      name: `${format}-bundle`,
    },
  );
}

function formatMarkedBundleRecord(params: {
  installPath: string;
  bundleFormat?: BundleFormat;
}): FormatMarkedBundleInstallRecord {
  return {
    source: "marketplace",
    format: "bundle",
    ...params,
  } satisfies FormatMarkedBundleInstallRecord;
}

function resolveTestHostRoot(): string {
  const hostRoot = resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
    cwd: process.cwd(),
  });
  expect(hostRoot).toBeTruthy();
  return hostRoot!;
}

async function resolveRealPath(target: string): Promise<string> {
  return await fs.realpath(target).catch(() => target);
}

async function writeHostDependency(dir: string, dependencyField: string, native = true) {
  await writePackage(
    dir,
    {
      name: "@clawemail/email",
      main: native ? "index.js" : "dist/index.js",
      [dependencyField]: { openclaw: "2026.7.1" },
      ...(native ? { openclaw: { extensions: ["./index.js"] } } : {}),
    },
    "export default {};",
  );
  await writeJson(path.join(dir, "node_modules/openclaw/package.json"), {
    name: "openclaw",
    version: "2026.7.1-beta.2",
  });
}

async function checkExtension(extensions: string[], entry?: string) {
  const dir = path.join(tmpRoot, "brave");
  await writePackage(dir, {
    name: "@openclaw/brave-plugin",
    main: "missing-main.js",
    openclaw: { extensions },
  });
  if (entry) {
    await fs.mkdir(path.dirname(path.join(dir, entry)), { recursive: true });
    await fs.writeFile(path.join(dir, entry), "export default {};\n", "utf8");
  }
  return { dir, result: await checkPackage("brave", dir) };
}

it("checks a selected manifest root without an installed-index record", async () => {
  const dir = path.join(tmpRoot, "codex");
  await writePackage(
    dir,
    { name: "@openclaw/codex", openclaw: { extensions: ["./index.js"] } },
    "export default {};",
  );
  const result = await runPluginPayloadSmokeCheckForManifestRecords({
    plugins: [{ id: "codex", rootDir: dir }],
    env: {},
  });

  expect(result).toEqual({ checked: ["codex"], failures: [] });
});

it.each([
  { dependencyField: "dependencies", expectedFailures: 0 },
  { dependencyField: "peerDependencies", expectedFailures: 1 },
] as const)(
  "keeps $dependencyField host checks aligned with selected-manifest ownership provenance",
  async ({ dependencyField, expectedFailures }) => {
    const dir = path.join(tmpRoot, `manifest-${dependencyField}`);
    await writeHostDependency(dir, dependencyField);

    const manifestResult = await runPluginPayloadSmokeCheckForManifestRecords({
      plugins: [{ id: "email", rootDir: dir }],
      env: {},
    });
    const authoritativeResult = await checkPackage("email", dir);

    expect(manifestResult.failures).toHaveLength(expectedFailures);
    expect(authoritativeResult.failures).toEqual([
      expect.objectContaining({ reason: "missing-openclaw-peer-link" }),
    ]);
  },
);

it.each([false, true])("reports missing package payload (directory exists: %s)", async (exists) => {
  const dir = path.join(tmpRoot, "brave");
  if (exists) {
    await fs.mkdir(dir, { recursive: true });
  }
  const result = await checkPackage("brave", dir);
  expectFailure(
    result,
    "brave",
    dir,
    exists ? "missing-package-json" : "missing-package-dir",
    exists ? `package.json is missing under ${dir}` : `Install dir is missing: ${dir}`,
  );
});

it.each([
  ["agent", "format"],
  ["codex", "clawhubFamily"],
  ["claude", "marker"],
  ["cursor", "marketplace"],
] as const)(
  "accepts a tracked %s bundle record via %s metadata",
  async (bundleFormat, metadataKind) => {
    const dir = path.join(tmpRoot, `${bundleFormat}-bundle`);
    await writeBundle(dir, bundleFormat, undefined, metadataKind === "marker");
    if (metadataKind === "marketplace") {
      await writeJson(path.join(dir, "package.json"), null);
    }
    const result = await checkRecord(
      `${bundleFormat}-bundle`,
      metadataKind === "clawhubFamily"
        ? { source: "clawhub", clawhubFamily: "bundle-plugin", installPath: dir }
        : metadataKind === "marketplace"
          ? {
              source: "marketplace",
              installPath: dir,
              marketplaceName: "Local",
              marketplaceSource: "local/repo",
              marketplacePlugin: "marketplace-bundle",
            }
          : formatMarkedBundleRecord({
              installPath: dir,
              ...(metadataKind === "format" ? { bundleFormat } : {}),
            }),
    );
    expect(result).toEqual({ checked: [`${bundleFormat}-bundle`], failures: [] });
  },
);

it.each([
  ["missing", "missing-bundle-manifest", undefined],
  [
    "non-object",
    "invalid-bundle-manifest",
    "Bundle manifest validation failed: plugin manifest must be an object",
  ],
  [
    "dual-format",
    "missing-extension-entry",
    "Plugin extension entry validation failed: extension entry not found: ./missing-extension.js",
  ],
] as const)(
  "validates %s bundle payloads without requiring package.json",
  async (kind, reason, detail) => {
    const dir = path.join(tmpRoot, "bundle");
    if (kind === "missing") {
      await fs.mkdir(path.join(dir, ".codex-plugin"), { recursive: true });
    } else {
      await writeBundle(dir, "codex", kind === "non-object" ? [] : undefined);
      if (kind === "dual-format") {
        await writePackage(dir, {
          name: "dual-format-bundle",
          openclaw: { extensions: ["./missing-extension.js"] },
        });
      }
    }
    const record =
      kind === "missing"
        ? formatMarkedBundleRecord({ installPath: dir, bundleFormat: "codex" })
        : ({ source: "clawhub", clawhubFamily: "bundle-plugin", installPath: dir } as const);
    expectFailure(
      await checkRecord("bundle", record),
      "bundle",
      dir,
      reason,
      detail ?? `No supported bundle manifest or bundle marker found under ${dir}`,
    );
  },
);

it.each([
  { extensions: ["./index.js", " "], entry: "index.js", error: "[1] must be a non-empty string" },
  { extensions: [], entry: undefined, error: " is empty" },
])(
  "reports only extension failure for $error even when main is missing",
  async ({ extensions, entry, error }) => {
    const { dir, result } = await checkExtension(extensions, entry);
    expectFailure(
      result,
      "brave",
      dir,
      "missing-extension-entry",
      `Plugin extension entry validation failed: package.json openclaw.extensions${error}`,
    );
  },
);

it.each([
  ["./index.js", "index.js"],
  ["./index.ts", "dist/index.js"],
])("accepts %s via %s without requiring the npm main", async (extension, entry) => {
  const { result } = await checkExtension([extension], entry);
  expect(result.failures).toEqual([]);
});

it.each(["missing", "wrong root", "host root"])(
  "audits the openclaw peer link: %s",
  async (target) => {
    const dir = path.join(tmpRoot, "codex");
    await writePackage(
      dir,
      {
        name: "@openclaw/codex",
        main: "dist/index.js",
        peerDependencies: { openclaw: ">=2026.5.18-beta.1" },
      },
      "export default {};\n",
    );
    const peerPath = path.join(dir, "node_modules", "openclaw");
    const wrongRoot = path.join(tmpRoot, "old-openclaw");
    if (target !== "missing") {
      await fs.mkdir(wrongRoot, { recursive: true });
      await fs.mkdir(path.dirname(peerPath), { recursive: true });
      await fs.symlink(
        target === "host root" ? resolveTestHostRoot() : wrongRoot,
        peerPath,
        "junction",
      );
    }
    const result = await checkPackage("codex", dir);
    if (target === "host root") {
      expect(result.failures).toEqual([]);
    } else if (target === "missing") {
      expectFailure(
        result,
        "codex",
        dir,
        "missing-openclaw-peer-link",
        `Plugin declares peerDependency "openclaw" but peer link audit failed: missing ${peerPath}.`,
      );
    } else {
      expect(result.failures).toEqual([
        expect.objectContaining({
          pluginId: "codex",
          installPath: dir,
          reason: "missing-openclaw-peer-link",
          detail: expect.stringContaining(
            `${peerPath} points to ${await resolveRealPath(wrongRoot)} instead of ${await resolveRealPath(resolveTestHostRoot())}`,
          ),
        }),
      ]);
    }
  },
);

it("does not quarantine a shipped git plugin for an unmanaged direct host dependency", async () => {
  const dir = path.join(tmpRoot, "git-email");
  await writeHostDependency(dir, "dependencies", false);
  expect((await checkRecord("email", { source: "git", installPath: dir })).failures).toEqual([]);
});

it("reports a failure when `main` resolves to a directory rather than a file", async () => {
  const dir = path.join(tmpRoot, "dir-main");
  await writePackage(dir, { name: "dir-main", main: "lib" });
  await fs.mkdir(path.join(dir, "lib"), { recursive: true });
  const result = await checkPackage("x", dir);
  expectFailure(
    result,
    "x",
    dir,
    "missing-main-entry",
    `Plugin main entry "lib" not found at ${path.join(dir, "lib")}`,
  );
});

it.each([
  [
    "not-json",
    process.versions.bun
      ? 'JSON Parse error: Unexpected identifier "not"'
      : "Unexpected token 'o', \"not-json\" is not valid JSON",
  ],
  ["null", "package.json must be an object"],
])(
  "reports invalid package.json %s and continues checking later plugins",
  async (content, error) => {
    const dir = path.join(tmpRoot, "broken");
    const laterDir = path.join(tmpRoot, "later");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "package.json"), content, "utf8");
    await writePackage(laterDir, { name: "later", main: "missing.js" });

    const result = await runPluginPayloadSmokeCheck({
      records: {
        broken: { source: "npm", installPath: dir },
        later: { source: "npm", installPath: laterDir },
      },
      env: {},
    });

    expect(result.checked).toEqual(["broken", "later"]);
    expect(result.failures).toStrictEqual([
      {
        pluginId: "broken",
        installPath: dir,
        reason: "invalid-package-json",
        detail: `Could not parse package.json: ${error}`,
      },
      {
        pluginId: "later",
        installPath: laterDir,
        reason: "missing-main-entry",
        detail: `Plugin main entry "missing.js" not found at ${path.join(laterDir, "missing.js")}`,
      },
    ]);
  },
);

it.each(["EACCES"])("classifies a %s package.json read failure as unreadable", async (code) => {
  const dir = path.join(tmpRoot, "unreadable");
  const packageJsonPath = path.join(dir, "package.json");
  await writePackage(dir, { name: "unreadable" });
  vi.spyOn(fs, "readFile").mockRejectedValueOnce(
    Object.assign(new Error(`${code}: could not read ${packageJsonPath}`), { code }),
  );

  const result = await checkPackage("unreadable", dir);

  expectFailure(
    result,
    "unreadable",
    dir,
    "unreadable-package-json",
    `Could not read package.json at ${packageJsonPath}: ${code}: could not read ${packageJsonPath}`,
  );
});

it("reports a failure when an install record is missing installPath", async () => {
  const result = await checkRecord("discord", { source: "npm" });
  expect(result.checked).toEqual(["discord"]);
  expect(result.failures).toEqual([
    {
      pluginId: "discord",
      reason: "missing-install-path",
      detail: "Install path is missing from the plugin install record.",
    },
  ]);
});

it("only checks records whose source is package-tracked (npm/clawhub/git/marketplace)", async () => {
  const dir = path.join(tmpRoot, "tracked");
  await writePackage(dir, { name: "tracked" }, "module.exports = {};");
  const records = {
    bundled: { source: "bundled", installPath: dir } as never,
    npm: { source: "npm" as const, installPath: dir },
  };
  const result = await runPluginPayloadSmokeCheck({ records, env: {} });
  expect(result.checked).toEqual(["npm"]);
});
