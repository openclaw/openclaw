import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
// Npm Package Lock Generator tests cover transient npm package-lock behavior.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPackageExtensionPeerMetadata,
  collectOverrideViolations,
  collectPnpmLockViolations,
  createNpmPackageLockInstallStrategyArgs,
  createNpmLockExecOptions,
  createNpmLockCommand,
  disableDependencyShrinkwrapOverrideConflictSources,
  exactOverrideRulesFromOverrides,
  normalizeNpmVersionDrift,
  normalizeOverrides,
  packageJsonForNpmLock,
  pnpmLockOverrideVersionForVersions,
  parsePnpmPackageKey,
  parseLockPackagePath,
  resolvePnpmLockOverridePlan,
  resolvePackageDirs,
  resolveNpmLockJobs,
  shouldUseLegacyPeerDepsForNpmLock,
  npmLockPackageDirsForChangedPaths,
} from "../../scripts/generate-npm-package-lock.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("generate-npm-package-lock", () => {
  function repoRelativePath(value: string): string {
    return path.relative(process.cwd(), value).replaceAll("\\", "/");
  }

  it("omits workspace packages that are published beside the package", () => {
    const normalized = packageJsonForNpmLock(
      {
        bundleDependencies: ["chalk"],
        bundledDependencies: ["chalk"],
        dependencies: { "@openclaw/ai": "workspace:2026.6.11", chalk: "5.6.2" },
        devDependencies: { local: "workspace:*" },
        peerDependencies: { host: "workspace:^1.2.3" },
      },
      {},
    );

    expect(normalized).not.toHaveProperty("bundleDependencies");
    expect(normalized).not.toHaveProperty("bundledDependencies");
    expect(normalized).not.toHaveProperty("devDependencies");
    expect(normalized.dependencies).toEqual({ chalk: "5.6.2" });
    expect(normalized.peerDependencies).toEqual({});
  });

  it("omits package platform constraints from the portable lock-generation manifest", () => {
    const normalized = packageJsonForNpmLock(
      {
        os: ["darwin"],
        cpu: ["arm64"],
        libc: ["glibc"],
        dependencies: { chalk: "5.6.2" },
      },
      {},
    );

    expect(normalized).not.toHaveProperty("os");
    expect(normalized).not.toHaveProperty("cpu");
    expect(normalized).not.toHaveProperty("libc");
    expect(normalized.dependencies).toEqual({ chalk: "5.6.2" });
  });

  it("runs npm package-lock generation through cmd.exe for Windows npm shims", () => {
    const execPath = "C:\\nodejs\\node.exe";
    const npmCmdPath = path.win32.resolve(path.win32.dirname(execPath), "npm.cmd");

    expect(
      createNpmLockCommand(["install", "--package-lock-only"], {
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        env: {},
        execPath,
        existsSync: (candidate: string) => candidate === npmCmdPath,
        platform: "win32",
      }),
    ).toEqual({
      args: ["/d", "/s", "/c", `${npmCmdPath} install --package-lock-only`],
      command: "C:\\Windows\\System32\\cmd.exe",
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("bounds npm-lock command runtime and captured output by default", () => {
    expect(
      createNpmLockExecOptions({ command: "npm", args: ["install"] }, "/tmp/package", {}),
    ).toMatchObject({
      cwd: "/tmp/package",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10 * 60 * 1000,
    });
  });

  it("adds explicit npm install strategies for package-lock generation", () => {
    expect(createNpmPackageLockInstallStrategyArgs({ installStrategy: "shallow" })).toEqual([
      "--install-strategy=shallow",
    ]);
    expect(createNpmPackageLockInstallStrategyArgs({})).toEqual([]);
    expect(() =>
      createNpmPackageLockInstallStrategyArgs({ installStrategy: "global" as never }),
    ).toThrow("invalid npm package-lock install strategy: global");
  });

  it("normalizes pnpm scoped override selectors for npm package locks", () => {
    expect(
      normalizeOverrides({
        "openclaw@2026.5.28>undici": "8.5.0",
        "parent>unused-adapter": "-",
        tar: 7.5,
      }),
    ).toEqual({
      "openclaw@2026.5.28": {
        undici: "8.5.0",
      },
      tar: "7.5",
    });
  });

  it("preserves range selectors containing comparison operators", () => {
    expect(
      normalizeOverrides({
        "undici@>=7.0.0 <8.0.0": "7.29.1",
        "undici@>=8.0.0 <8.9.0": "8.10.2",
      }),
    ).toEqual({
      "undici@>=7.0.0 <8.0.0": "7.29.1",
      "undici@>=8.0.0 <8.9.0": "8.10.2",
    });
  });

  it("preserves version selectors on both sides of parent-child overrides", () => {
    expect(
      normalizeOverrides({
        "bar>foo@1": "2",
        "bar@>=1 <2>@scope/unused": "-",
        "bar@>=1 <2>@scope/foo@>=3 <4": "4",
      }),
    ).toEqual({
      bar: { "foo@1": "2" },
      "bar@>=1 <2": { "@scope/foo@>=3 <4": "4" },
    });
  });

  it.each([false, true])(
    "retains parent and child overrides during normalization (childrenFirst=%s)",
    (childrenFirst) => {
      const entries = [
        ["parent", "1.2.3"],
        ["parent>child", "2.0.0"],
        ["parent>sibling", "3.0.0"],
      ];
      expect(
        normalizeOverrides(Object.fromEntries(childrenFirst ? entries.toReversed() : entries)),
      ).toEqual({
        parent: { ".": "1.2.3", child: "2.0.0", sibling: "3.0.0" },
      });
    },
  );

  it("rejects short flag package selectors before resolving npm-lock targets", () => {
    expect(() => resolvePackageDirs(["--package-dir", "-h"])).toThrow(
      "--package-dir requires a package directory.",
    );
    expect(() => resolvePackageDirs(["--changed", "--base", "-h"])).toThrow(
      "--base requires a git ref.",
    );
    expect(() => resolvePackageDirs(["--changed", "--head", "-h"])).toThrow(
      "--head requires a git ref.",
    );
    expect(() => resolvePackageDirs(["--jobs", "-h"])).toThrow(
      "--jobs requires a positive integer.",
    );
  });

  it("validates npm-lock worker counts from flags and environment", () => {
    expect(resolveNpmLockJobs("3", {})).toBe(3);
    expect(resolveNpmLockJobs(undefined, { OPENCLAW_NPM_LOCK_JOBS: "2" })).toBe(2);
    expect(() => resolveNpmLockJobs("0", {})).toThrow("invalid OPENCLAW_NPM_LOCK_JOBS: 0");
    expect(() => resolveNpmLockJobs("17", {})).toThrow("maximum is 16");
  });

  it.each([1, 2])(
    "loads source policy in workers independently of tooling policy (jobs=%s)",
    (jobs) => {
      const root = tempDirs.make("openclaw-npm-source-lock-");
      const invalidRoot = path.join(root, "invalid-tooling-policy");
      mkdirSync(invalidRoot);
      writeFileSync(path.join(invalidRoot, "pnpm-lock.yaml"), "invalid: [");
      writeFileSync(
        path.join(root, "pnpm-lock.yaml"),
        JSON.stringify({
          packages: { "fixture-dep@1.0.0": { resolution: { integrity: "sha512-fixture" } } },
        }),
      );
      writeFileSync(path.join(root, "pnpm-workspace.yaml"), "{}\n");
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "source-fixture", version: "1.0.0" }),
      );
      const script = `import { generateNpmPackageLocks } from ${JSON.stringify(new URL("../../scripts/generate-npm-package-lock.mts", import.meta.url).href)};
      console.log(JSON.stringify(await generateNpmPackageLocks({ rootDir: ${JSON.stringify(root)}, packageDirs: [${JSON.stringify(root)}], jobs: ${jobs} })));`;
      const scriptPath = path.join(root, "generate.mjs");
      writeFileSync(scriptPath, script);
      const result = spawnSync(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), scriptPath],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT: invalidRoot,
            npm_config_offline: "true",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const [text] = JSON.parse(result.stdout);
      expect(JSON.parse(text)).toMatchObject({
        name: "source-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
      });
    },
  );

  it("accepts strict npm-lock command timeout and buffer overrides", () => {
    expect(
      createNpmLockExecOptions({ command: "npm", args: ["install"] }, "/tmp/package", {
        OPENCLAW_NPM_LOCK_COMMAND_MAX_BUFFER_BYTES: "1048576",
        OPENCLAW_NPM_LOCK_COMMAND_TIMEOUT_MS: "30000",
      }),
    ).toMatchObject({
      maxBuffer: 1024 * 1024,
      timeout: 30000,
    });
  });

  it("rejects loose npm-lock command timeout and buffer overrides", () => {
    expect(() =>
      createNpmLockExecOptions({ command: "npm", args: ["install"] }, "/tmp/package", {
        OPENCLAW_NPM_LOCK_COMMAND_TIMEOUT_MS: "30s",
      }),
    ).toThrow("invalid OPENCLAW_NPM_LOCK_COMMAND_TIMEOUT_MS: 30s");
    expect(() =>
      createNpmLockExecOptions({ command: "npm", args: ["install"] }, "/tmp/package", {
        OPENCLAW_NPM_LOCK_COMMAND_MAX_BUFFER_BYTES: "64mb",
      }),
    ).toThrow("invalid OPENCLAW_NPM_LOCK_COMMAND_MAX_BUFFER_BYTES: 64mb");
  });

  it("pins same-line pnpm lock versions to the newest locked patch", () => {
    expect(pnpmLockOverrideVersionForVersions(new Set(["3.972.38"]))).toBe("3.972.38");
    expect(pnpmLockOverrideVersionForVersions(new Set(["3.972.38", "3.972.39"]))).toBe("3.972.39");
    expect(pnpmLockOverrideVersionForVersions(new Set(["3.972.39", "3.973.0"]))).toBeNull();
    expect(pnpmLockOverrideVersionForVersions(new Set(["3.972.39", "4.0.0"]))).toBeNull();
  });

  it("pins the published runtime graph independently of unrelated workspace versions", () => {
    const root = tempDirs.make("openclaw-npm-runtime-policy-");
    const localDir = path.join(root, "local");
    mkdirSync(localDir);
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "{}\n");
    writeFileSync(
      path.join(localDir, "package.json"),
      JSON.stringify({
        dependencies: { "local-child": "2.0.0" },
        peerDependencies: { "absent-optional-peer": "^1.0.0" },
        peerDependenciesMeta: { "absent-optional-peer": { optional: true } },
      }),
    );
    const snapshots = {
      "first@1.0.0": { dependencies: { helper: "8.0.0" } },
      "second@1.0.0": { optionalDependencies: { helper: "8.0.0" } },
      "helper@8.0.0": {},
      "helper@7.0.0": {},
      "host@3.1.0": {},
      "local-child@2.0.0": {},
      "packed@1.0.0": { dependencies: { helper: "8.0.0" } },
    };
    writeFileSync(
      path.join(root, "pnpm-lock.yaml"),
      JSON.stringify({
        packages: Object.fromEntries(Object.keys(snapshots).map((key) => [key, {}])),
        snapshots,
      }),
    );
    const manifest = {
      dependencies: {
        alias: "npm:first@1.0.0",
        local: "file:./local",
        packed: "file:./packed.tgz",
      },
      optionalDependencies: { second: "1.0.0" },
      peerDependencies: { host: "^3.0.0" },
      devDependencies: { helper: "7.0.0" },
    };
    const script = `import { readNpmLockOverrides } from ${JSON.stringify(new URL("../../scripts/generate-npm-package-lock.mts", import.meta.url).href)};
      const manifest = ${JSON.stringify(manifest)};
      const artifacts = [{ name: "packed", version: "1.0.0", spec: "file:./packed.tgz", integrity: "sha512-fixture" }];
      const read = (input) => readNpmLockOverrides(input, ${JSON.stringify(root)}, artifacts);
      let missing;
      try { read({ dependencies: { absent: "1.0.0" } }); } catch (error) { missing = error.message; }
      console.log(JSON.stringify({
        native: read(manifest),
        legacy: read({ ...manifest, peerDependenciesMeta: { host: { optional: true } } }),
        empty: read({ devDependencies: { helper: "7.0.0" } }),
        missing,
      }));`;
    const result = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script],
      { encoding: "utf8", env: { ...process.env, OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT: root } },
    );
    expect(result.status, result.stderr).toBe(0);
    const policy = JSON.parse(result.stdout);
    expect(policy.native).toEqual({
      first: "1.0.0",
      second: "1.0.0",
      helper: "8.0.0",
      host: "3.1.0",
      "local-child": "2.0.0",
      packed: "1.0.0",
    });
    expect(policy.legacy).toEqual({ ...policy.native, host: undefined });
    expect(policy.empty).toEqual({});
    expect(policy.missing).toContain("no runtime resolution for absent@1.0.0");
  });

  it("keeps explicit workspace root policy when a runtime uses its scoped fork", () => {
    const root = tempDirs.make("openclaw-npm-scoped-workspace-policy-");
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      JSON.stringify({
        overrides: {
          forked: "2.0.0",
          "parent@1.0.0>forked": "1.0.0",
        },
      }),
    );
    writeFileSync(
      path.join(root, "pnpm-lock.yaml"),
      JSON.stringify({
        packages: {
          "parent@1.0.0": {},
          "forked@1.0.0": {},
          "forked@2.0.0": {},
        },
        snapshots: {
          "parent@1.0.0": { dependencies: { forked: "1.0.0" } },
          "forked@1.0.0": {},
          "forked@2.0.0": {},
        },
      }),
    );
    const script = `import { readNpmLockOverrides } from ${JSON.stringify(new URL("../../scripts/generate-npm-package-lock.mts", import.meta.url).href)};
      console.log(JSON.stringify(readNpmLockOverrides({ dependencies: { parent: "1.0.0" } }, ${JSON.stringify(root)})));`;
    const result = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script],
      { encoding: "utf8", env: { ...process.env, OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT: root } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      parent: { ".": "1.0.0", forked: "1.0.0" },
      forked: "2.0.0",
      "parent@1.0.0": { forked: "1.0.0" },
    });
  });

  it("pins a transitive workspace range to the pnpm resolution", () => {
    const root = tempDirs.make("openclaw-npm-ranged-workspace-policy-");
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      JSON.stringify({
        overrides: {
          forked: "^2.0.0",
          "parent@1.0.0>forked": "1.0.0",
        },
      }),
    );
    writeFileSync(
      path.join(root, "pnpm-lock.yaml"),
      JSON.stringify({
        packages: {
          "parent@1.0.0": {},
          "other@1.0.0": {},
          "forked@1.0.0": {},
          "forked@2.0.0": {},
        },
        snapshots: {
          "parent@1.0.0": { dependencies: { forked: "1.0.0" } },
          "other@1.0.0": { dependencies: { forked: "2.0.0" } },
          "forked@1.0.0": {},
          "forked@2.0.0": {},
        },
      }),
    );
    const script = `import { readNpmLockOverrides } from ${JSON.stringify(new URL("../../scripts/generate-npm-package-lock.mts", import.meta.url).href)};
      console.log(JSON.stringify(readNpmLockOverrides({ dependencies: { parent: "1.0.0", other: "1.0.0" } }, ${JSON.stringify(root)})));`;
    const result = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script],
      { encoding: "utf8", env: { ...process.env, OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT: root } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      parent: { ".": "1.0.0", forked: "1.0.0" },
      other: { ".": "1.0.0", forked: "2.0.0" },
      forked: "2.0.0",
      "parent@1.0.0": { forked: "1.0.0" },
      "other@1.0.0": { forked: "2.0.0" },
    });
  });

  it("uses scoped forks unless peer contexts conflict under one parent", () => {
    const plan = resolvePnpmLockOverridePlan({
      packages: {
        "@emnapi/core@1.11.1": {},
        "@emnapi/core@1.11.2": {},
        "@types/retry@0.12.0": {},
        "@types/retry@0.12.5": {},
      },
      snapshots: {
        "@napi-rs/wasm-runtime@1.1.6(@emnapi/core@1.11.1)": {
          dependencies: { "@emnapi/core": "1.11.1" },
        },
        "@napi-rs/wasm-runtime@1.1.6(@emnapi/core@1.11.2)": {
          dependencies: { "@emnapi/core": "1.11.2" },
        },
        "@slack/web-api@8.0.0": {
          dependencies: { "@types/retry": "0.12.0" },
        },
        "@types/proper-lockfile@4.1.4": {
          dependencies: { "@types/retry": "0.12.5" },
        },
        "p-retry@4.6.2": {
          dependencies: { "@types/retry": "0.12.0" },
        },
      },
    });

    expect(plan).toEqual({
      conflictingPackageNames: ["@emnapi/core"],
      scopedVersionOverrides: {
        "@slack/web-api@8.0.0": { "@types/retry": "0.12.0" },
        "@types/proper-lockfile@4.1.4": { "@types/retry": "0.12.5" },
        "p-retry@4.6.2": { "@types/retry": "0.12.0" },
      },
      versionOverrides: { "@emnapi/core": "1.11.2" },
    });
  });

  it("parses nested scoped package paths", () => {
    expect(
      parseLockPackagePath("node_modules/@openclaw/codex/node_modules/@anthropic-ai/sdk"),
    ).toEqual([
      {
        name: "@openclaw/codex",
        path: "node_modules/@openclaw/codex",
      },
      {
        name: "@anthropic-ai/sdk",
        path: "node_modules/@openclaw/codex/node_modules/@anthropic-ai/sdk",
      },
    ]);
  });

  it("parses pnpm lock package keys", () => {
    expect(parsePnpmPackageKey("@aws-sdk/core@3.974.12")).toEqual({
      name: "@aws-sdk/core",
      version: "3.974.12",
    });
    expect(parsePnpmPackageKey("react-dom@19.2.4(react@19.2.4)")).toEqual({
      name: "react-dom",
      version: "19.2.4",
    });
    expect(parsePnpmPackageKey("invalid")).toBeNull();
  });

  it("disables embedded shrinkwraps that hide workspace overrides under npm 11", () => {
    const lockfile = {
      packages: {
        "": {
          dependencies: {
            "lru-cache": "^11.5.0",
          },
        },
        "node_modules/@openclaw/codex": {
          version: "0.75.4",
          hasShrinkwrap: true,
        },
        "node_modules/@openclaw/codex/node_modules/protobufjs": {
          version: "7.5.9",
        },
        "node_modules/@openclaw/codex/node_modules/fetch-blob": {
          version: "4.0.0",
        },
        "node_modules/@openclaw/codex/node_modules/fetch-blob/node_modules/node-domexception": {
          version: "1.0.0",
        },
      },
    };
    const overrideRules = exactOverrideRulesFromOverrides({
      protobufjs: "8.4.0",
      "node-domexception": "npm:@nolyfill/domexception@1.0.28",
    });

    expect(collectOverrideViolations(lockfile, overrideRules)).toHaveLength(2);
    expect(disableDependencyShrinkwrapOverrideConflictSources(lockfile, overrideRules)).toEqual([
      "node_modules/@openclaw/codex",
    ]);
    expect(lockfile.packages["node_modules/@openclaw/codex"]).not.toHaveProperty("hasShrinkwrap");
    expect(
      lockfile.packages["node_modules/@openclaw/codex/node_modules/protobufjs"],
    ).toBeUndefined();
  });

  it("attributes a hoisted override violation to its dependency shrinkwrap", () => {
    const lockfile = {
      packages: {
        "": { dependencies: { parent: "1.0.0" } },
        "node_modules/parent": {
          dependencies: { forked: "1.0.0" },
          hasShrinkwrap: true,
          version: "1.0.0",
        },
        "node_modules/forked": { version: "1.0.0" },
      },
    };
    const overrides = { forked: "2.0.0", parent: "1.0.0" };

    expect(
      disableDependencyShrinkwrapOverrideConflictSources(
        lockfile,
        exactOverrideRulesFromOverrides(overrides),
        overrides,
      ),
    ).toEqual(["node_modules/parent"]);
    expect(lockfile.packages["node_modules/parent"]).not.toHaveProperty("hasShrinkwrap");
  });

  it("disables a shrinkwrap that violates a scoped rule with the global version", () => {
    const lockfile = {
      packages: {
        "": { dependencies: { parent: "1.0.0" } },
        "node_modules/parent": {
          dependencies: { forked: "2.0.0" },
          hasShrinkwrap: true,
          version: "1.0.0",
        },
        "node_modules/forked": { version: "2.0.0" },
      },
    };
    const overrides = {
      forked: "2.0.0",
      parent: { ".": "1.0.0", forked: "1.0.0" },
    };

    expect(
      disableDependencyShrinkwrapOverrideConflictSources(
        lockfile,
        exactOverrideRulesFromOverrides(overrides),
        overrides,
      ),
    ).toEqual(["node_modules/parent"]);
  });

  it("matches a scoped override against the incoming dependency range", () => {
    const lockfile = {
      packages: {
        "": { dependencies: { parent: "^1.0.0" } },
        "node_modules/parent": {
          dependencies: { forked: "2.0.0" },
          hasShrinkwrap: true,
          version: "1.1.0",
        },
        "node_modules/forked": { version: "2.0.0" },
      },
    };
    const overrides = {
      "parent@1.0.0": { forked: "1.0.0" },
    };

    expect(
      disableDependencyShrinkwrapOverrideConflictSources(
        lockfile,
        exactOverrideRulesFromOverrides(overrides),
        overrides,
      ),
    ).toEqual(["node_modules/parent"]);
  });

  it.each([
    {
      expected: ["node_modules/parent"],
      name: "plain Git spec",
      root: { dependencies: { parent: "git+https://example.test/parent.git" } },
    },
    {
      expected: ["node_modules/parent"],
      name: "hosted Git URL without suffix",
      root: { dependencies: { parent: "https://github.com/example/parent" } },
    },
    {
      expected: [],
      name: "hosted archive URL",
      root: {
        dependencies: { parent: "https://github.com/example/parent/archive/v1.0.0.tar.gz" },
      },
    },
    {
      expected: [],
      name: "local tarball",
      root: { dependencies: { parent: "file:./parent.tgz" } },
    },
    {
      expected: [],
      name: "local directory",
      root: { dependencies: { parent: "../parent" } },
    },
    {
      expected: ["node_modules/parent"],
      name: "GitHub shorthand",
      root: { dependencies: { parent: "example/parent" } },
    },
    {
      expected: [],
      name: "Git semver range",
      root: { dependencies: { parent: "git+https://example.test/parent.git#semver:^1.0.0" } },
    },
    {
      expected: [],
      name: "npm alias range",
      root: { dependencies: { parent: "npm:aliased-parent@^1.0.0" } },
    },
    {
      expected: ["node_modules/parent"],
      name: "optional dependency precedence",
      root: {
        dependencies: { parent: "1.0.0" },
        optionalDependencies: { parent: "2.0.0" },
      },
    },
  ])("matches scoped selectors using the effective edge spec ($name)", ({ expected, root }) => {
    const lockfile = {
      packages: {
        "": root,
        "node_modules/parent": {
          dependencies: { forked: "1.0.0" },
          hasShrinkwrap: true,
          version: "1.1.0",
        },
        "node_modules/forked": { version: "1.0.0" },
      },
    };
    const overrides = {
      forked: "2.0.0",
      "parent@1.0.0": { forked: "1.0.0" },
    };

    expect(
      disableDependencyShrinkwrapOverrideConflictSources(
        lockfile,
        exactOverrideRulesFromOverrides(overrides),
        overrides,
      ),
    ).toEqual(expected);
  });

  it("enforces a version-qualified override object's implicit parent version", () => {
    const lockfile = {
      packages: {
        "": { dependencies: { wrapper: "1.0.0" } },
        "node_modules/wrapper": {
          dependencies: { parent: "^1.0.0" },
          hasShrinkwrap: true,
          version: "1.0.0",
        },
        "node_modules/parent": {
          dependencies: { forked: "1.0.0" },
          version: "1.1.0",
        },
        "node_modules/forked": { version: "1.0.0" },
      },
    };
    const overrides = {
      "parent@1.0.0": { forked: "1.0.0" },
    };

    expect(
      disableDependencyShrinkwrapOverrideConflictSources(
        lockfile,
        exactOverrideRulesFromOverrides(overrides),
        overrides,
      ),
    ).toEqual(["node_modules/wrapper"]);
  });

  it("applies a wildcard scoped override to a plain Git edge", () => {
    const lockfile = {
      packages: {
        "": { dependencies: { parent: "git+https://example.test/parent.git" } },
        "node_modules/parent": {
          dependencies: { forked: "2.0.0" },
          hasShrinkwrap: true,
          version: "1.1.0",
        },
        "node_modules/forked": { version: "2.0.0" },
      },
    };
    const overrides = {
      forked: "2.0.0",
      "parent@*": { forked: "1.0.0" },
    };

    expect(
      disableDependencyShrinkwrapOverrideConflictSources(
        lockfile,
        exactOverrideRulesFromOverrides(overrides),
        overrides,
      ),
    ).toEqual(["node_modules/parent"]);
  });

  it.each([
    { actualName: "foo", expected: ["node_modules/parent"], name: "original package" },
    { actualName: "patched-foo", expected: [], name: "alias target" },
  ])("validates npm override alias identity ($name)", ({ actualName, expected }) => {
    const lockfile = {
      packages: {
        "": { dependencies: { parent: "1.0.0" } },
        "node_modules/parent": {
          dependencies: { foo: "1.0.0" },
          hasShrinkwrap: true,
          version: "1.0.0",
        },
        "node_modules/foo": { name: actualName, version: "1.0.0" },
      },
    };
    const overrides = { foo: "npm:patched-foo@1.0.0" };

    expect(
      disableDependencyShrinkwrapOverrideConflictSources(
        lockfile,
        exactOverrideRulesFromOverrides(overrides),
        overrides,
      ),
    ).toEqual(expected);
  });

  it("accepts a hoisted peer that satisfies its scoped override", () => {
    const lockfile = {
      packages: {
        "": { dependencies: { parent: "1.0.0" } },
        "node_modules/parent": {
          peerDependencies: { forked: "1.0.0" },
          version: "1.0.0",
        },
        "node_modules/forked": { version: "1.0.0" },
      },
    };
    const overrides = {
      forked: "2.0.0",
      parent: { ".": "1.0.0", forked: "1.0.0" },
    };

    expect(
      disableDependencyShrinkwrapOverrideConflictSources(
        lockfile,
        exactOverrideRulesFromOverrides(overrides),
        overrides,
      ),
    ).toEqual([]);
  });

  it("detects npm package-lock entries that bypass the pnpm lock", () => {
    const lockfile = {
      packages: {
        "": {},
        "node_modules/react": {
          version: "19.2.6",
        },
        "node_modules/@nolyfill/domexception": {
          version: "1.0.28",
        },
      },
    };
    const pnpmPackages = new Set(["react@19.2.4", "@nolyfill/domexception@1.0.28"]);

    expect(collectPnpmLockViolations(lockfile, pnpmPackages, new Map())).toEqual([
      {
        packageKey: "react@19.2.6",
        path: "node_modules/react",
      },
    ]);
  });

  it.each([false, true, "range"])(
    "preserves child override policies when a direct dependency is bound to a local artifact (qualified=%s)",
    (qualified) => {
      const artifact = {
        name: "patched",
        version: "1.0.0",
        spec: "file:./patched.tgz",
        integrity: "sha512-local",
      };
      const manifest = {
        dependencies: { patched: "1.0.0" },
        overrides: qualified
          ? { "patched@1.0.0": { scopedChild: "3.0.0" }, patched: { child: "2.0.0" } }
          : { patched: { child: "2.0.0" }, "patched@1.0.0": { scopedChild: "3.0.0" } },
      };
      const policy = qualified
        ? { "patched@1.0.0": { ".": qualified === "range" ? "^1.0.0" : "1.0.0", child: "2.0.0" } }
        : { patched: "1.0.0" };
      const normalized = packageJsonForNpmLock(manifest, policy, [artifact]);
      expect(normalized.overrides).toEqual({
        "patched@1.0.0": {
          ".": "$patched",
          child: "2.0.0",
          ...(qualified ? { scopedChild: "3.0.0" } : {}),
        },
        patched: { ...(qualified ? {} : { ".": "1.0.0" }), child: "2.0.0" },
      });
      expect(packageJsonForNpmLock(normalized, policy, [artifact])).toEqual(normalized);
      expect(manifest.dependencies.patched).toBe("1.0.0");
    },
  );

  it("preserves wildcard child policies for prerelease artifacts", () => {
    const artifact = {
      name: "patched",
      version: "1.0.0-beta.1",
      spec: "file:./patched.tgz",
      integrity: "sha512-local",
    };
    const normalized = packageJsonForNpmLock(
      {
        dependencies: { patched: artifact.version },
        overrides: { "patched@*": { ".": "*", child: "2.0.0" } },
      },
      {},
      [artifact],
    );
    expect(normalized.overrides).toMatchObject({
      "patched@1.0.0-beta.1": { ".": "$patched", child: "2.0.0" },
    });
  });

  it.each(["conflicting", "disjoint"])(
    "keeps shadowed exact children out of artifact normalization reentry (%s)",
    (scenario) => {
      const artifact = {
        name: "patched",
        version: "1.0.0",
        spec: "file:./patched.tgz",
        integrity: "sha512-local",
      };
      const manifest = {
        dependencies: { patched: "1.0.0" },
        overrides: { "patched@^1.0.0": { ".": "1.0.0", child: "2.0.0" } },
      };
      const policy = {
        "patched@1.0.0": {
          ".": "1.0.0",
          [scenario === "conflicting" ? "child" : "shadowedChild"]: "3.0.0",
        },
      };
      const normalized = packageJsonForNpmLock(manifest, policy, [artifact]);
      expect(normalized.overrides).toMatchObject({
        "patched@1.0.0": { ".": "$patched", child: "2.0.0" },
      });
      expect(packageJsonForNpmLock(normalized, policy, [artifact])).toEqual(normalized);
    },
  );

  it("does not treat an ordinary dependency reference as a normalized artifact", () => {
    expect(() =>
      packageJsonForNpmLock(
        {
          dependencies: { patched: "1.0.0" },
          overrides: { "patched@1.0.0": { ".": "$patched", child: "2.0.0" } },
        },
        { "patched@1.0.0": { ".": "1.0.0", child: "3.0.0" } },
        [
          {
            name: "patched",
            version: "1.0.0",
            spec: "file:./patched.tgz",
            integrity: "sha512-local",
          },
        ],
      ),
    ).toThrow("overrides.child conflicts");
  });

  it.each(["^2.0.0", "npm:other@1.0.0"])(
    "rejects an incompatible artifact own override (%s)",
    (spec) => {
      expect(() =>
        packageJsonForNpmLock(
          { dependencies: { patched: "1.0.0" } },
          { "patched@1.0.0": { ".": spec } },
          [
            {
              name: "patched",
              version: "1.0.0",
              spec: "file:./patched.tgz",
              integrity: "sha512-local",
            },
          ],
        ),
      ).toThrow("local package artifact conflicts with override");
    },
  );

  it("keeps registry integrity checks outside the bound direct artifact occurrence", () => {
    const artifact = {
      name: "patched",
      version: "1.0.0",
      spec: "file:./patched.tgz",
      integrity: "sha512-local",
    };
    expect(
      collectPnpmLockViolations(
        {
          packages: {
            "node_modules/patched": { version: "1.0.0", integrity: artifact.integrity },
            "node_modules/parent/node_modules/patched": {
              version: "1.0.0",
              integrity: artifact.integrity,
            },
            "node_modules/sibling": { version: "1.0.0", integrity: "sha512-tampered" },
          },
        },
        new Set(["patched@1.0.0", "sibling@1.0.0"]),
        new Map([
          ["patched@1.0.0", new Set(["sha512-registry"])],
          ["sibling@1.0.0", new Set(["sha512-sibling"])],
        ]),
        [artifact],
      ),
    ).toEqual([
      {
        path: "node_modules/parent/node_modules/patched",
        packageKey: "patched@1.0.0",
        actualIntegrity: "sha512-local",
        expectedIntegrities: ["sha512-registry"],
      },
      {
        path: "node_modules/sibling",
        packageKey: "sibling@1.0.0",
        actualIntegrity: "sha512-tampered",
        expectedIntegrities: ["sha512-sibling"],
      },
    ]);
  });

  it("preserves scoped hoists and repairs unrelated shrinkwraps in final locks", async () => {
    const root = tempDirs.make("openclaw-npm-scoped-shrinkwrap-");
    const packageDir = path.join(root, "plugin");
    mkdirSync(packageDir);

    const writePackage = (
      packageRoot: string,
      manifest: Record<string, unknown>,
      shrinkwrap?: Record<string, unknown>,
    ) => {
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify(manifest));
      writeFileSync(path.join(packageRoot, "index.js"), "module.exports = true;\n");
      if (shrinkwrap) {
        writeFileSync(path.join(packageRoot, "npm-shrinkwrap.json"), JSON.stringify(shrinkwrap));
      }
    };
    const packPackage = (source: string) => {
      const pack = spawnSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", packageDir],
        { cwd: source, encoding: "utf8" },
      );
      expect(pack.status, pack.stderr).toBe(0);
      const packed = JSON.parse(pack.stdout);
      const [{ filename }] = Array.isArray(packed) ? packed : Object.values(packed);
      const tarball = path.join(packageDir, filename);
      const manifest = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
      return {
        artifact: {
          name: manifest.name,
          version: manifest.version,
          spec: `file:./${filename}`,
          integrity: `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`,
        },
        manifest,
        tarball,
      };
    };
    const writeParent = (
      name: string,
      dependencies: Record<string, string>,
      withShrinkwrap: boolean,
    ) => {
      const source = path.join(root, name);
      writePackage(source, {
        name,
        version: "1.0.0",
        main: "index.js",
        dependencies,
      });
      if (withShrinkwrap) {
        writeFileSync(
          path.join(source, "npm-shrinkwrap.json"),
          JSON.stringify({
            name,
            version: "1.0.0",
            lockfileVersion: 3,
            requires: true,
            packages: {
              "": { name, version: "1.0.0", dependencies },
              ...Object.fromEntries(
                Object.entries(dependencies).map(([dependencyName, version]) => [
                  `node_modules/${dependencyName}`,
                  { version },
                ]),
              ),
            },
          }),
        );
      }
      return packPackage(source);
    };

    const parent = writeParent("parent", { forked: "1.0.0" }, false);
    const unrelated = writeParent("unrelated", { forked: "1.0.0", blocked: "1.0.0" }, true);
    const violator = writeParent("violator", { forked: "1.0.0", replacement: "1.0.0" }, true);
    const forkedPackages = ["1.0.0", "2.0.0"].map((version) => {
      const source = path.join(root, `forked-${version}`);
      writePackage(source, { name: "forked", version, main: "index.js" });
      return packPackage(source);
    });
    const blockedPackages = ["1.0.0", "2.0.0"].map((version) => {
      const source = path.join(root, `blocked-${version}`);
      writePackage(source, { name: "blocked", version, main: "index.js" });
      return packPackage(source);
    });
    const replacementPackages = ["1.0.0", "2.0.0"].map((version) => {
      const source = path.join(root, `replacement-${version}`);
      const dependencies = version === "2.0.0" ? { blocked: "1.0.0" } : {};
      writePackage(
        source,
        { name: "replacement", version, main: "index.js", dependencies },
        version === "2.0.0"
          ? {
              name: "replacement",
              version,
              lockfileVersion: 3,
              requires: true,
              packages: {
                "": { name: "replacement", version, dependencies },
                "node_modules/blocked": { version: "1.0.0" },
              },
            }
          : undefined,
      );
      return packPackage(source);
    });
    const registryConfig = path.join(root, "registry.json");
    writeFileSync(
      registryConfig,
      JSON.stringify({
        parent: {
          "1.0.0": {
            integrity: parent.artifact.integrity,
            manifest: parent.manifest,
            tarball: parent.tarball,
          },
        },
        unrelated: {
          "1.0.0": {
            integrity: unrelated.artifact.integrity,
            manifest: unrelated.manifest,
            tarball: unrelated.tarball,
          },
        },
        violator: {
          "1.0.0": {
            integrity: violator.artifact.integrity,
            manifest: violator.manifest,
            tarball: violator.tarball,
          },
        },
        forked: Object.fromEntries(
          forkedPackages.map(({ artifact, manifest, tarball }) => [
            artifact.version,
            { integrity: artifact.integrity, manifest, tarball },
          ]),
        ),
        blocked: Object.fromEntries(
          blockedPackages.map(({ artifact, manifest, tarball }) => [
            artifact.version,
            { integrity: artifact.integrity, manifest, tarball },
          ]),
        ),
        replacement: Object.fromEntries(
          replacementPackages.map(({ artifact, manifest, tarball }) => [
            artifact.version,
            { integrity: artifact.integrity, manifest, tarball },
          ]),
        ),
      }),
    );
    const registryScript = path.join(root, "registry.mjs");
    writeFileSync(
      registryScript,
      `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const packages = JSON.parse(readFileSync(process.argv[2], "utf8"));
const server = createServer((request, response) => {
  const port = server.address().port;
  const packageName = request.url?.slice(1);
  const versions = packageName ? packages[packageName] : undefined;
  if (versions) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ name: packageName, "dist-tags": { latest: Object.keys(versions).at(-1) }, versions: Object.fromEntries(Object.entries(versions).map(([version, entry]) => [version, { ...entry.manifest, dist: { integrity: entry.integrity, tarball: \`http://127.0.0.1:\${port}/\${packageName}/-/\${packageName}-\${version}.tgz\` } }])) }));
    return;
  }
  const match = request.url?.match(/^\\/([^/]+)\\/-\\/[^/]+-(.+)\\.tgz$/u);
  const entry = match ? packages[match[1]]?.[match[2]] : undefined;
  if (!entry) {
    response.statusCode = 404;
    response.end("not found");
    return;
  }
  response.setHeader("content-type", "application/octet-stream");
  response.end(readFileSync(entry.tarball));
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
    );
    const registry = spawn(process.execPath, [registryScript, registryConfig], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const registryPort = await new Promise<number>((resolve, reject) => {
      registry.once("error", reject);
      registry.once("exit", (code) => reject(new Error(`fixture registry exited ${code}`)));
      registry.stdout.once("data", (chunk) => resolve(Number(String(chunk))));
    });
    try {
      const artifacts: unknown[] = [];

      writeFileSync(
        path.join(root, "pnpm-workspace.yaml"),
        JSON.stringify({
          overrides: {
            forked: "2.0.0",
            blocked: "2.0.0",
            replacement: "2.0.0",
            "parent@1.0.0>forked": "1.0.0",
            "unrelated@1.0.0>forked": "1.0.0",
          },
        }),
      );
      writeFileSync(
        path.join(root, "pnpm-lock.yaml"),
        JSON.stringify({
          packages: {
            "parent@1.0.0": {},
            "unrelated@1.0.0": {},
            "violator@1.0.0": {},
            "forked@1.0.0": {},
            "forked@2.0.0": {},
            "blocked@1.0.0": {},
            "blocked@2.0.0": {},
            "replacement@1.0.0": {},
            "replacement@2.0.0": {},
          },
          snapshots: {
            "parent@1.0.0": { dependencies: { forked: "1.0.0" } },
            "unrelated@1.0.0": {
              dependencies: { forked: "1.0.0", blocked: "2.0.0" },
            },
            "violator@1.0.0": {
              dependencies: { forked: "2.0.0", replacement: "2.0.0" },
            },
            "forked@1.0.0": {},
            "forked@2.0.0": {},
            "blocked@1.0.0": {},
            "blocked@2.0.0": {},
            "replacement@1.0.0": {},
            "replacement@2.0.0": { dependencies: { blocked: "2.0.0" } },
          },
        }),
      );
      const generateLock = (
        dependencies: Record<string, string>,
        localPackageArtifacts: unknown[],
      ) => {
        writeFileSync(
          path.join(packageDir, "package.json"),
          JSON.stringify({ name: "fixture-plugin", version: "1.0.0", dependencies }),
        );
        const script = `import { generateNpmPackageLock } from ${JSON.stringify(new URL("../../scripts/generate-npm-package-lock.mts", import.meta.url).href)};
        console.log(generateNpmPackageLock(${JSON.stringify(packageDir)}, { localPackageArtifacts: ${JSON.stringify(localPackageArtifacts)} }));`;
        const result = spawnSync(
          process.execPath,
          ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script],
          {
            cwd: root,
            encoding: "utf8",
            env: {
              ...process.env,
              OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT: root,
              npm_config_registry: `http://127.0.0.1:${registryPort}`,
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout);
      };

      const lock = generateLock(
        {
          parent: "1.0.0",
          unrelated: "1.0.0",
          violator: "1.0.0",
          forked: "2.0.0",
          blocked: "2.0.0",
        },
        artifacts,
      );
      expect(lock.packages["node_modules/forked"].version).toBe("2.0.0");
      expect(lock.packages["node_modules/blocked"].version).toBe("2.0.0");
      expect(lock.packages["node_modules/parent/node_modules/forked"].version).toBe("1.0.0");
      expect(lock.packages["node_modules/unrelated/node_modules/forked"].version).toBe("1.0.0");
      expect(lock.packages["node_modules/unrelated/node_modules/blocked"]).toBeUndefined();
      expect(lock.packages["node_modules/violator/node_modules/forked"]).toBeUndefined();
      expect(lock.packages["node_modules/replacement"].version).toBe("2.0.0");
      expect(lock.packages["node_modules/replacement/node_modules/blocked"]).toBeUndefined();

      const hoisted = generateLock({ parent: "1.0.0" }, artifacts);
      expect(hoisted.packages["node_modules/forked"].version).toBe("1.0.0");
      expect(hoisted.packages["node_modules/parent/node_modules/forked"]).toBeUndefined();

      writeFileSync(
        path.join(root, "pnpm-workspace.yaml"),
        JSON.stringify({
          overrides: {
            violator: "^1.0.0",
            forked: "^2.0.0",
            replacement: "^2.0.0",
            blocked: "^2.0.0",
            "violator@1.0.0>forked": "2.0.0",
            "violator@1.0.0>replacement": "2.0.0",
            "replacement@2.0.0>blocked": "2.0.0",
          },
        }),
      );
      const nestedOnly = generateLock({ violator: "^1.0.0" }, artifacts);
      expect(nestedOnly.packages["node_modules/forked"].version).toBe("2.0.0");
      expect(nestedOnly.packages["node_modules/replacement"].version).toBe("2.0.0");
      expect(nestedOnly.packages["node_modules/replacement/node_modules/blocked"]).toBeUndefined();

      writeFileSync(
        path.join(root, "pnpm-workspace.yaml"),
        JSON.stringify({
          overrides: {
            unrelated: "^1.0.0",
            forked: "^2.0.0",
            blocked: "^2.0.0",
          },
        }),
      );
      const rangedRoots = generateLock({ unrelated: "^1.0.0" }, artifacts);
      expect(rangedRoots.packages["node_modules/forked"].version).toBe("2.0.0");
      expect(rangedRoots.packages["node_modules/blocked"].version).toBe("2.0.0");
      expect(rangedRoots.packages["node_modules/unrelated/node_modules/forked"]).toBeUndefined();
      expect(rangedRoots.packages["node_modules/unrelated/node_modules/blocked"]).toBeUndefined();
    } finally {
      registry.kill();
    }
  });

  it.each(["valid", "tampered", "wrong-version", "outside-root", "symlink-escape"])(
    "validates real local dependency tarballs before accepting npm locks (%s)",
    (scenario) => {
      const root = tempDirs.make("openclaw-npm-patched-lock-");
      const source = path.join(root, "source");
      const packageDir = path.join(root, "plugin");
      mkdirSync(source);
      mkdirSync(packageDir);
      writeFileSync(
        path.join(root, "pnpm-workspace.yaml"),
        JSON.stringify(
          scenario === "valid" ? { overrides: { "fixture-dep>fixture-extra": "3.0.0" } } : {},
        ),
      );
      writeFileSync(
        path.join(root, "pnpm-lock.yaml"),
        JSON.stringify({
          packages: {
            "fixture-dep@1.0.0": { resolution: { integrity: "sha512-registry" } },
            ...(scenario === "valid"
              ? {
                  "fixture-child@1.0.0": {},
                  "fixture-child@2.0.0": {},
                  "fixture-extra@3.0.0": {},
                  "fixture-sibling@1.0.0": {},
                }
              : {}),
          },
          snapshots: {
            "fixture-dep@1.0.0": {},
            ...(scenario === "valid"
              ? {
                  "fixture-dep@1.0.0": {
                    dependencies: { "fixture-child": "1.0.0", "fixture-sibling": "1.0.0" },
                  },
                  "fixture-child@1.0.0": {},
                  "fixture-child@2.0.0": {},
                  "fixture-extra@3.0.0": {},
                  "fixture-sibling@1.0.0": { dependencies: { "fixture-child": "2.0.0" } },
                }
              : {}),
          },
        }),
      );
      writeFileSync(
        path.join(source, "package.json"),
        JSON.stringify({
          name: "fixture-dep",
          version: scenario === "wrong-version" ? "2.0.0" : "1.0.0",
          main: "index.js",
        }),
      );
      writeFileSync(path.join(source, "index.js"), "module.exports = 2;\n");
      const pack = spawnSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", packageDir],
        { cwd: source, encoding: "utf8" },
      );
      expect(pack.status, pack.stderr).toBe(0);
      const packed = JSON.parse(pack.stdout);
      const [{ filename }] = Array.isArray(packed) ? packed : Object.values(packed);
      const tarball = path.join(packageDir, filename);
      const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
      if (scenario === "tampered") {
        writeFileSync(tarball, "tampered");
      }
      if (scenario === "symlink-escape") {
        const outside = path.join(root, "outside");
        mkdirSync(outside);
        writeFileSync(path.join(outside, filename), readFileSync(tarball));
        symlinkSync(outside, path.join(packageDir, "linked"), "junction");
      }
      const artifact = {
        name: "fixture-dep",
        version: "1.0.0",
        spec:
          scenario === "outside-root"
            ? `file:../plugin/${filename}`
            : scenario === "symlink-escape"
              ? `file:./linked/${filename}`
              : `file:./${filename}`,
        integrity,
      };
      writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: "fixture-plugin",
          version: "1.0.0",
          dependencies: { "fixture-dep": "1.0.0" },
          ...(scenario === "wrong-version"
            ? { overrides: { "fixture-dep": { child: "2.0.0" } } }
            : {}),
        }),
      );
      const script = `import { generateNpmPackageLock, readNpmLockOverrides } from ${JSON.stringify(new URL("../../scripts/generate-npm-package-lock.mts", import.meta.url).href)};
      const lock = JSON.parse(generateNpmPackageLock(${JSON.stringify(packageDir)}, { localPackageArtifacts: ${JSON.stringify([artifact])} }));
      console.log(JSON.stringify({ lock, overrides: readNpmLockOverrides({ dependencies: { "fixture-dep": "1.0.0" } }, ${JSON.stringify(packageDir)}) }));`;
      const result = spawnSync(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT: root },
        },
      );
      if (scenario === "valid") {
        expect(result.status, result.stderr).toBe(0);
        const generated = JSON.parse(result.stdout);
        expect(generated.lock.packages["node_modules/fixture-dep"]).toMatchObject({
          version: "1.0.0",
          integrity,
        });
        expect(generated.overrides["fixture-dep"]).toEqual({
          ".": "1.0.0",
          "fixture-child": "1.0.0",
          "fixture-extra": "3.0.0",
        });
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          scenario === "tampered"
            ? "local package artifact integrity mismatch"
            : scenario === "wrong-version"
              ? "violates workspace overrides: node_modules/fixture-dep locked 2.0.0, expected 1.0.0"
              : scenario === "symlink-escape"
                ? "local package artifact escapes package root"
                : "invalid local package artifact",
        );
      }
      expect(readFileSync(path.join(source, "index.js"), "utf8")).toBe("module.exports = 2;\n");
    },
  );

  it("normalizes npm patch-version metadata drift", () => {
    expect(
      normalizeNpmVersionDrift({
        packages: {
          "node_modules/@rollup/rollup-linux-x64-gnu": {
            version: "4.53.5",
            cpu: ["x64"],
            libc: ["glibc"],
            optional: true,
            os: ["linux"],
          },
          "node_modules/zod": {
            version: "4.4.3",
            deprecated: "Use another package",
            peer: true,
          },
          "node_modules/keeps-peer-false": {
            version: "1.0.0",
            peer: false,
          },
        },
      }),
    ).toEqual({
      packages: {
        "node_modules/@rollup/rollup-linux-x64-gnu": {
          version: "4.53.5",
          cpu: ["x64"],
          optional: true,
          os: ["linux"],
        },
        "node_modules/zod": {
          version: "4.4.3",
        },
        "node_modules/keeps-peer-false": {
          version: "1.0.0",
          peer: false,
        },
      },
    });
  });

  it("uses legacy peer resolution when package extensions mark dependency peers optional", () => {
    expect(
      shouldUseLegacyPeerDepsForNpmLock(
        { dependencies: { baileys: "7.0.0-rc13" } },
        { baileys: { peerDependenciesMeta: { sharp: { optional: true } } } },
      ),
    ).toBe(true);
    expect(
      shouldUseLegacyPeerDepsForNpmLock(
        { dependencies: { "not-baileys": "1.0.0" } },
        { baileys: { peerDependenciesMeta: { sharp: { optional: true } } } },
      ),
    ).toBe(false);
  });

  it("uses legacy peer resolution when the package has optional peers", () => {
    expect(
      shouldUseLegacyPeerDepsForNpmLock({
        dependencies: { zod: "4.4.3" },
        peerDependencies: { openclaw: ">=2026.5.30" },
        peerDependenciesMeta: { openclaw: { optional: true } },
      }),
    ).toBe(true);
  });

  it("applies package extension peer metadata to generated npm package locks", () => {
    expect(
      applyPackageExtensionPeerMetadata(
        {
          packages: {
            "node_modules/baileys": {
              version: "7.0.0-rc13",
              peerDependencies: {
                "audio-decode": "^2.1.3",
                sharp: "*",
              },
              peerDependenciesMeta: {
                "audio-decode": { optional: true },
              },
            },
          },
        },
        { baileys: { peerDependenciesMeta: { sharp: { optional: true } } } },
      ),
    ).toEqual({
      packages: {
        "node_modules/baileys": {
          version: "7.0.0-rc13",
          peerDependencies: {
            "audio-decode": "^2.1.3",
            sharp: "*",
          },
          peerDependenciesMeta: {
            "audio-decode": { optional: true },
            sharp: { optional: true },
          },
        },
      },
    });
  });

  it("targets changed publishable plugin manifests", () => {
    expect(
      npmLockPackageDirsForChangedPaths([
        "extensions/acpx/package.json",
        "extensions/acpx/deps/local-runtime/package.json",
      ]).map(repoRelativePath),
    ).toEqual(["extensions/acpx"]);
  });

  it("does not normalize raw Git filename boundaries into package manifests", () => {
    expect(
      npmLockPackageDirsForChangedPaths([
        " extensions/acpx/package.json",
        "extensions/acpx/package.json ",
        String.raw`extensions\acpx\package.json`,
      ]),
    ).toEqual([]);
  });

  it("targets the changed publishable gateway protocol manifest", () => {
    expect(
      npmLockPackageDirsForChangedPaths(["packages/gateway-protocol/package.json"]).map(
        repoRelativePath,
      ),
    ).toEqual(["packages/gateway-protocol"]);
  });

  it("falls back to every npm lock when lockfile ownership is ambiguous", () => {
    const packageDirs = npmLockPackageDirsForChangedPaths(["pnpm-lock.yaml"]).map(repoRelativePath);

    expect(packageDirs).toContain("");
    expect(packageDirs).toContain("packages/gateway-client");
    expect(packageDirs).toContain("packages/gateway-protocol");
    expect(packageDirs).toContain("extensions/acpx");
  });

  it("falls back to every npm lock when mixed lockfile changes do not map to packages", () => {
    const packageDirs = npmLockPackageDirsForChangedPaths([
      "extensions/acpx/package.json",
      "pnpm-lock.yaml",
    ]).map(repoRelativePath);

    expect(packageDirs).toContain("");
    expect(packageDirs).toContain("extensions/acpx");
    expect(packageDirs.length).toBeGreaterThan(1);
  });
});
