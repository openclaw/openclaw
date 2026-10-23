import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { mergeOverrides, readNpmLockOverrides } from "../scripts/generate-npm-package-lock.mts";
import { pnpmLockfileDocuments } from "../scripts/lib/pnpm-lockfile-documents.mjs";

type WorkspaceConfig = {
  allowBuilds?: Record<string, boolean>;
  blockExoticSubdeps?: boolean;
  onlyBuiltDependencies?: string[];
  minimumReleaseAge?: number;
  minimumReleaseAgeStrict?: boolean;
  verifyDepsBeforeRun?: boolean;
};

type RootPackageJson = {
  dependencies: { tar: string };
  pnpm?: WorkspaceConfig;
};

type PnpmEnvironmentLock = {
  importers?: Record<
    string,
    {
      packageManagerDependencies?: Record<string, { version?: string }>;
    }
  >;
  packages?: Record<string, unknown>;
  snapshots?: Record<string, { optionalDependencies?: Record<string, string> }>;
};

function readPackageJson(): RootPackageJson {
  return JSON.parse(fs.readFileSync("package.json", "utf8")) as RootPackageJson;
}

function readPnpmEnvironmentLock(): PnpmEnvironmentLock {
  const committedLockfile = execFileSync("git", ["show", "HEAD:pnpm-lock.yaml"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const environment = pnpmLockfileDocuments(committedLockfile).environment;
  if (!environment) {
    throw new Error("pnpm-lock.yaml is missing its environment document");
  }
  return parse(environment) as PnpmEnvironmentLock;
}

it("keeps pnpm 12 environment lock portable across platforms", () => {
  const lockfile = readPnpmEnvironmentLock();
  const packageManagerDependencies = lockfile.importers?.["."]?.packageManagerDependencies;
  const pnpmVersion = packageManagerDependencies?.pnpm?.version;
  if (typeof pnpmVersion !== "string") {
    throw new Error("pnpm environment lock is missing its package manager version");
  }
  if (Number.parseInt(pnpmVersion, 10) < 12) {
    return;
  }

  expect(packageManagerDependencies).not.toHaveProperty("@pnpm/exe");
  expect(
    Object.keys(lockfile.packages ?? {}).filter((key) => key.startsWith("@pnpm/exe@")),
  ).toEqual([]);
  expect(
    Object.keys(lockfile.snapshots ?? {}).filter((key) => key.startsWith("@pnpm/exe@")),
  ).toEqual([]);

  const platformExecutables = Object.keys(
    lockfile.snapshots?.[`pnpm@${pnpmVersion}`]?.optionalDependencies ?? {},
  ).filter((name) => name.startsWith("@pnpm/exe."));
  expect(platformExecutables.length).toBeGreaterThan(0);
  for (const packageName of platformExecutables) {
    expect(lockfile.packages).toHaveProperty(`${packageName}@${pnpmVersion}`);
    expect(lockfile.snapshots).toHaveProperty(`${packageName}@${pnpmVersion}`);
  }
});

it("keeps optional native Discord opus builds disabled by default", () => {
  const packageJson = readPackageJson();
  const workspace = parse(fs.readFileSync("pnpm-workspace.yaml", "utf8")) as WorkspaceConfig;

  expect(packageJson.pnpm).toBeUndefined();
  expect(workspace).toMatchObject({
    allowBuilds: { "@discordjs/opus": false },
    blockExoticSubdeps: true,
    minimumReleaseAge: 7 * 24 * 60,
    minimumReleaseAgeStrict: true,
    verifyDepsBeforeRun: false,
  });
  expect(workspace.onlyBuiltDependencies).toBeUndefined();
});

it("pins forked transitive dependencies with parent-scoped npm-lock overrides", () => {
  const tarVersion = readPackageJson().dependencies.tar;
  const dependencies = { minipass: "3.3.6", tar: tarVersion };
  const overrides = readNpmLockOverrides({ dependencies }, process.cwd());

  expect(overrides.yallist).toBeUndefined();
  expect(overrides["minipass@3.3.6"]).toMatchObject({ yallist: "4.0.0" });
  expect(overrides[`tar@${tarVersion}`]).toMatchObject({ yallist: "5.0.0" });
});

it.each([
  { first: "package", second: "workspace", childrenFirst: false, rootSpec: "1.2.3" },
  { first: "package", second: "lock", childrenFirst: true, rootSpec: "npm:@scope/parent@1.2.3" },
] as const)(
  "retains child policy and $rootSpec across sources $first/$second (childrenFirst=$childrenFirst)",
  ({ first, second, childrenFirst, rootSpec }) => {
    const sources: Record<"package" | "workspace" | "lock", Record<string, unknown>> = {
      package: {},
      workspace: {},
      lock: {},
    };
    const children = { parent: { child: "2.0.0" } };
    const self = { parent: rootSpec };
    sources[first] = childrenFirst ? children : self;
    sources[second] = childrenFirst ? self : children;

    expect(mergeOverrides(sources.package, sources.workspace, sources.lock)).toEqual({
      parent: { ".": rootSpec, child: "2.0.0" },
    });
  },
);

it.each([false, true])("preserves npm alias pins (nested first: %s)", (nestedFirst) => {
  const alias = { "node-domexception": "npm:@nolyfill/domexception@1.0.28" };
  const nested = { "node-domexception": { ".": "1.0.28", child: "2.0.0" } };
  expect(mergeOverrides(nestedFirst ? nested : alias, nestedFirst ? alias : nested, {})).toEqual({
    "node-domexception": {
      ".": "npm:@nolyfill/domexception@1.0.28",
      child: "2.0.0",
    },
  });
});

it.each([
  ["^1.0.0", "~1.0.0"],
  ["npm:@safe/foo@1.0.0", "npm:@other/foo@1.0.0"],
])("rejects conflicting root pins %s and %s when merging nested pins", (left, right) => {
  for (const nestedFirst of [false, true]) {
    const scalar = { "floating-package": nestedFirst ? right : left };
    const nested = { "floating-package": { ".": nestedFirst ? left : right, child: "2.0.0" } };
    expect(() =>
      mergeOverrides(nestedFirst ? nested : scalar, nestedFirst ? scalar : nested, {}),
    ).toThrow(/conflicts with pnpm lock policy/u);
  }
});
