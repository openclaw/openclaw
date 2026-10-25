import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateNpmPackageLocks } from "../../scripts/generate-npm-package-lock.mts";
import { generateNpmPackageLocksReport } from "../../scripts/npm-package-locks-report.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => `${"a".repeat(40)}\n`),
}));
vi.mock("../../scripts/generate-npm-package-lock.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/generate-npm-package-lock.mts")>()),
  generateNpmPackageLocks: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const dependency = {
  version: "1.0.0",
  resolved: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz",
  integrity: "sha512-fixture",
};
const npmPath = "node_modules/npm";
const nestedPath = `${npmPath}/node_modules/foo/node_modules/bar`;
type Lock = ReturnType<typeof lockFor>;

function sourceFixture(packages: Record<string, Record<string, unknown>>) {
  const root = tempDirs.make("openclaw-npm-lock-report-");
  mkdirSync(path.join(root, "extensions"));
  mkdirSync(path.join(root, "packages"));
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  for (const [dir, fields] of Object.entries(packages)) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(
      path.join(root, dir, "package.json"),
      JSON.stringify({
        name: dir === "." ? "openclaw" : `@openclaw/${path.basename(dir)}`,
        version: "2026.9.1",
        dependencies: { fixture: "1.0.0" },
        ...fields,
      }),
    );
  }
  return root;
}

function fixture() {
  const packages: Record<string, Record<string, unknown>> = { ".": {} };
  // Reverse creation order ensures discovery, not fixture order, owns sorting.
  for (const [dir, dependencyKind, publishToNpm, bundleRuntimeDependencies] of [
    ["packages/zulu", "optionalDependencies", true, true],
    ["extensions/beta", "dependencies", true, undefined],
    ["extensions/acpx", "dependencies", true, false],
    ["extensions/empty", "devDependencies", true, undefined],
    ["extensions/private", "dependencies", false, undefined],
  ] as const) {
    packages[dir] = {
      dependencies: undefined,
      [dependencyKind]: { fixture: "1.0.0" },
      openclaw: { release: { publishToNpm, bundleRuntimeDependencies } },
    };
  }
  return sourceFixture(packages);
}

function lockFor(packageDir: string, bundled = false) {
  const { name, version } = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const packages: Record<string, Record<string, unknown>> = {
    "": { name, version },
    "node_modules/fixture": { ...dependency },
  };
  if (bundled) {
    Object.assign(packages, {
      "node_modules/npm": {
        version: "11.20.0",
        resolved: "https://registry.npmjs.org/npm/-/npm-11.20.0.tgz",
        integrity: "sha512-fixture-npm",
      },
      // Reverse path order exercises report sorting, including scoped packages.
      [nestedPath]: { version: "2.0.0", inBundle: true },
      "node_modules/npm/node_modules/foo": { version: "1.0.0", inBundle: true },
      "node_modules/npm/node_modules/@gar/promise-retry": { version: "1.0.3", inBundle: true },
    });
  }
  return { name, version, lockfileVersion: 3, requires: true, packages };
}

function mockLocks(build: (dir: string) => unknown) {
  vi.mocked(generateNpmPackageLocks).mockImplementation(async ({ packageDirs }) =>
    packageDirs.map((dir) => JSON.stringify(build(dir))),
  );
}

async function rejectsLock(change: (lock: Lock) => void, error: string | RegExp, bundled = false) {
  mockLocks((dir) => {
    const lock = lockFor(dir, bundled);
    change(lock);
    return lock;
  });
  await expect(generateNpmPackageLocksReport({ rootDir: fixture() })).rejects.toThrow(error);
}

describe("npm package-lock release report", () => {
  beforeEach(() => {
    mockLocks(lockFor);
  });

  it("binds the exact schema, sorted runtime package coverage and hashes to the source root", async () => {
    const rootDir = fixture();
    const report = await generateNpmPackageLocksReport({ rootDir, jobs: 2 });
    expect(report).toEqual({
      schemaVersion: 1,
      generatedAt: expect.any(String),
      generator: "scripts/npm-package-locks-report.mts",
      sourceSha: "a".repeat(40),
      packageVersion: "2026.9.1",
      pnpmLockSha256: hash("lockfileVersion: '9.0'\n"),
      lockfileVersion: 3,
      packagesWithOmittedWorkspaceDependencies: 0,
      packages: [".", "extensions/acpx", "extensions/beta", "packages/zulu"].map((packageDir) => {
        const lock = lockFor(path.join(rootDir, packageDir));
        return {
          packageDir,
          name: packageDir === "." ? "openclaw" : `@openclaw/${path.basename(packageDir)}`,
          version: "2026.9.1",
          bundleRuntimeDependencies:
            packageDir === "extensions/beta" || packageDir === "packages/zulu",
          dependencyCount: packageDir === "packages/zulu" ? 0 : 1,
          optionalDependencyCount: packageDir === "packages/zulu" ? 1 : 0,
          omittedWorkspaceDependencies: [],
          bundledDependencies: [],
          lockSha256: hash(`${JSON.stringify(lock, null, 2)}\n`),
          lock,
        };
      }),
    });
    expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
  });

  it("marks only the root and gateway client partial in the release-split fixture", async () => {
    const root = sourceFixture({
      ".": { dependencies: { "@openclaw/ai": "workspace:*", fixture: "1.0.0" } },
      "packages/gateway-client": {
        dependencies: { "@openclaw/gateway-protocol": "workspace:*", fixture: "1.0.0" },
        openclaw: { release: { publishToNpm: true } },
      },
      "extensions/acpx": {
        devDependencies: { "@openclaw/plugin-sdk": "workspace:*" },
        openclaw: { release: { publishToNpm: true, bundleRuntimeDependencies: false } },
      },
    });
    const report = await generateNpmPackageLocksReport({ rootDir: root });
    expect(report).toMatchObject({
      packageVersion: "2026.9.1",
      packagesWithOmittedWorkspaceDependencies: 2,
      packages: [
        { name: "openclaw", omittedWorkspaceDependencies: ["@openclaw/ai"] },
        {
          name: "@openclaw/acpx",
          bundleRuntimeDependencies: false,
          omittedWorkspaceDependencies: [],
        },
        {
          name: "@openclaw/gateway-client",
          bundleRuntimeDependencies: true,
          omittedWorkspaceDependencies: ["@openclaw/gateway-protocol"],
        },
      ],
    });
  });

  it("sorts and deduplicates runtime omissions without including dev or peer references", async () => {
    const root = sourceFixture({
      ".": {
        dependencies: { zeta: "workspace:*", alpha: "workspace:^", fixture: "1.0.0" },
        optionalDependencies: { middle: "workspace:~", alpha: "workspace:^" },
        devDependencies: { development: "workspace:*" },
        peerDependencies: { peer: "workspace:*" },
      },
    });
    const report = await generateNpmPackageLocksReport({ rootDir: root });
    expect(report).toMatchObject({
      packagesWithOmittedWorkspaceDependencies: 1,
      packages: [{ omittedWorkspaceDependencies: ["alpha", "middle", "zeta"] }],
    });
  });

  it("rejects an omission claim when the generated lock resolves that workspace package", async () => {
    const root = sourceFixture({ ".": { dependencies: { "@openclaw/ai": "workspace:*" } } });
    mockLocks((dir) => {
      const lock = lockFor(dir);
      Object.assign(lock.packages, { "node_modules/@openclaw/ai": dependency });
      return lock;
    });
    await expect(generateNpmPackageLocksReport({ rootDir: root })).rejects.toThrow(
      ".: npm lock contains omitted workspace dependency @openclaw/ai",
    );
  });

  it("records sorted bundled dependencies with their verified carrier without changing lock bytes", async () => {
    const root = sourceFixture({ ".": { dependencies: { npm: "11.20.0" } } });
    const lock = lockFor(root, true);
    const lockBytes = `${JSON.stringify(lock, null, 2)}\n`;
    vi.mocked(generateNpmPackageLocks).mockResolvedValue([lockBytes]);

    const report = await generateNpmPackageLocksReport({ rootDir: root });
    expect(report.packages[0]).toMatchObject({
      bundledDependencies: [
        ["@gar/promise-retry", "@gar/promise-retry", "1.0.3"],
        ["foo", "foo", "1.0.0"],
        ["foo/node_modules/bar", "bar", "2.0.0"],
      ].map(([suffix, name, version]) => ({
        path: `node_modules/npm/node_modules/${suffix}`,
        name,
        version,
        parent: npmPath,
      })),
      lockSha256: hash(lockBytes),
    });
    expect(`${JSON.stringify(report.packages[0]!.lock, null, 2)}\n`).toBe(lockBytes);
  });

  it.each([
    ...[
      { integrity: undefined },
      { resolved: undefined },
      { dev: true },
      { link: true },
      { resolved: "file:npm.tgz" },
    ].map((invalid) => ({ carrier: npmPath, metadata: { ...dependency, ...invalid } })),
    { carrier: npmPath, metadata: undefined },
    { carrier: `${npmPath}/node_modules/foo`, metadata: undefined },
    { carrier: `${npmPath}/node_modules/foo`, metadata: { version: "1.0.0" } },
  ])("rejects unverifiable carrier $carrier: $metadata", async ({ carrier, metadata }) => {
    await rejectsLock(
      (lock) => Object.assign(lock.packages, { [carrier]: metadata }),
      `.: bundled npm lock entry ${nestedPath} has unverifiable carrier ${carrier}`,
      true,
    );
  });

  it("rejects a top-level bundle without a carrier", async () => {
    await rejectsLock((lock) => {
      lock.packages["node_modules/fixture"] = { version: "1.0.0", inBundle: true };
    }, ".: bundled npm lock entry node_modules/fixture has unverifiable carrier <root>");
  });

  it.each([
    ...[{ dev: true }, { link: true }, { resolved: "file:local.tgz" }].flatMap((invalid) =>
      [false, true].map((bundled) => ({ invalid, bundled })),
    ),
    ...[undefined, "", 1].map((version) => ({ invalid: { version }, bundled: true })),
    ...[
      "workspace:*",
      "git+https://example.com/repo",
      "git:repo",
      "ssh:repo",
      "https://github.com/org/repo",
      "",
      undefined,
    ].map((resolved) => ({ invalid: { resolved }, bundled: false })),
    ...[
      { integrity: "" },
      { integrity: undefined },
      { inBundle: "true", integrity: undefined },
    ].map((invalid) => ({ invalid, bundled: false })),
  ])("rejects unsupported entry $invalid (bundled=$bundled)", async ({ invalid, bundled }) => {
    const lockPath = bundled ? nestedPath : "node_modules/fixture";
    await rejectsLock(
      (lock) => Object.assign(lock.packages[lockPath]!, invalid),
      `.: unsupported npm lock entry ${lockPath}`,
      bundled,
    );
  });

  it.each(["name", "version", "lockfileVersion", "rootName", "rootVersion", "rootDev"])(
    "rejects mismatched identity or root metadata %s",
    async (field) => {
      await rejectsLock((lock) => {
        const isRoot = field.startsWith("root");
        const key = isRoot ? field.slice(4).toLowerCase() : field;
        Object.assign(isRoot ? lock.packages[""]! : lock, {
          [key]: key === "dev" ? true : "wrong",
        });
      }, /\.:/u);
    },
  );
});
