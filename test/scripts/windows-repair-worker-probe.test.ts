import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import {
  createPackagedOwnerLoader as createLoader,
  type PackagedOwnerEvidence,
} from "../../scripts/lib/windows-repair-package.mts";
import { resolveNpmRunner } from "../../scripts/npm-runner.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const loaders = new Set<Awaited<ReturnType<typeof createLoader>>>();
afterEach(() => {
  for (const loader of loaders) {
    loader[Symbol.dispose]();
  }
  loaders.clear();
});
async function createPackagedOwnerLoader(packageRoot: string, tarball: string) {
  const loader = await createLoader(packageRoot, tarball);
  loaders.add(loader);
  return loader;
}

async function fixture(
  files: Record<string, string>,
  bundled: Record<string, string> = {},
  manifest: {
    name: string;
    version: string;
    imports?: Record<string, string>;
    exports?: Record<string, string>;
  } = { name: "openclaw", version: "0.0.0" },
) {
  const root = directories.make("windows-repair-package-owner-");
  const packageRoot = path.join(root, "package");
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify(manifest));
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(packageRoot, "dist", name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  for (const [name, contents] of Object.entries(bundled)) {
    const file = path.join(packageRoot, "node_modules", name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  const lifecycleMarker = path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
  await fs.writeFile(lifecycleMarker, "pending\n");
  const tarball = path.join(root, "candidate.tgz");
  execFileSync("tar", ["-czf", path.basename(tarball), "package"], {
    cwd: root,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  await fs.rm(lifecycleMarker);
  return { packageRoot, tarball };
}

async function loadPackagedOwner(
  packageRoot: string,
  tarball: string,
  stem: string,
  names: string[],
  evidence: PackagedOwnerEvidence[],
) {
  const loadOwner = await createPackagedOwnerLoader(packageRoot, tarball);
  return loadOwner(stem, names, evidence);
}

it.each([
  { alias: "a", split: false },
  { alias: "$", split: false },
  { alias: "a", split: true },
  { alias: "$", split: true },
])(
  "loads named package owners through $alias with split chunks=$split",
  async ({ alias, split }) => {
    const admit = `function admit() { return "owned"; } export { admit as ${alias} };`;
    const finish = 'function finish() { return "finished"; } export { finish as f };';
    const facade = 'import { f as finish } from "./finish-fixture.mjs"; export { finish };';
    const rootSource = split ? admit : `${admit}\n${finish}`;
    const files: Record<string, string> = split
      ? {
          "executor-fixture.mjs": admit,
          "finish-fixture.mjs": finish,
          "executor-finish.mjs": facade,
        }
      : { "executor-fixture.mjs": rootSource };
    const { packageRoot, tarball } = await fixture(files);
    const evidence: PackagedOwnerEvidence[] = [];
    const owner = await loadPackagedOwner(
      packageRoot,
      tarball,
      "executor",
      ["admit", "finish"],
      evidence,
    );
    expect(owner.admit?.()).toBe("owned");
    expect(owner.finish?.()).toBe("finished");
    const expected: PackagedOwnerEvidence[] = [
      {
        file: "dist/executor-fixture.mjs",
        sha256: createHash("sha256").update(rootSource).digest("hex"),
        exports: split ? { admit: alias } : { admit: alias, finish: "f" },
      },
    ];
    if (split) {
      expected.push({
        file: "dist/executor-finish.mjs",
        sha256: createHash("sha256").update(facade).digest("hex"),
        exports: { finish: "finish" },
      });
    }
    expect(evidence).toHaveLength(expected.length);
    expect(evidence).toEqual(expect.arrayContaining(expected));
  },
);

it("authenticates every selected chunk before importing any owner", async () => {
  const { packageRoot, tarball } = await fixture({
    "executor-first.mjs":
      'throw new Error("unverified code executed"); function admit() {} export { admit as a };',
    "executor-second.mjs": "function finish() {} export { finish as f };",
  });
  await fs.writeFile(
    path.join(packageRoot, "dist", "executor-second.mjs"),
    'function finish() { return "changed"; } export { finish as f };',
  );
  await expect(
    loadPackagedOwner(packageRoot, tarball, "executor", ["admit", "finish"], []),
  ).rejects.toThrow("Installed module differs from the bound package");
});

it.each([
  { kind: "static", afterAdmission: false },
  { kind: "computed", afterAdmission: false },
  { kind: "owner", afterAdmission: true },
  { kind: "static", afterAdmission: true },
  { kind: "computed", afterAdmission: true },
  { kind: "lazy", afterAdmission: true },
  { kind: "bundled", afterAdmission: true },
])(
  "rejects $kind replacement with afterAdmission=$afterAdmission before evaluation",
  async ({ kind, afterAdmission }) => {
    const sources: Record<string, string> = {
      owner: 'function admit() { return "original"; } export { admit };',
      static:
        'import { value } from "./implementation.mjs"; function admit() { return value; } export { admit };',
      computed:
        'const module = "./implementation.mjs"; const { value } = await import(module); function admit() { return value; } export { admit };',
      lazy: 'async function admit() { return (await import("./implementation.mjs")).value; } export { admit };',
      bundled: 'import value from "bundled"; function admit() { return value; } export { admit };',
    };
    const { packageRoot, tarball } = await fixture(
      {
        "executor-fixture.mjs": sources[kind]!,
        "implementation.mjs": 'export const value = "original";',
      },
      kind === "bundled"
        ? {
            "bundled/package.json": '{"name":"bundled","version":"1.0.0","main":"index.cjs"}',
            "bundled/index.cjs": 'module.exports = "original";',
          }
        : {},
    );
    const target = path.join(
      packageRoot,
      kind === "bundled"
        ? "node_modules/bundled/index.cjs"
        : `dist/${kind === "owner" ? "executor-fixture" : "implementation"}.mjs`,
    );
    const changed =
      'console.log("UNVERIFIED_MODULE_EVALUATED"); ' +
      (kind === "owner"
        ? 'function admit() { return "changed"; } export { admit };'
        : kind === "bundled"
          ? 'module.exports = "changed";'
          : 'export const value = "changed";');
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { writeFile } from "node:fs/promises";
         const { createPackagedOwnerLoader } = await import(process.argv[1]);
         const replace = () => writeFile(process.argv[4], process.argv[5]);
         if (!${afterAdmission}) await replace();
         const loadOwner = await createPackagedOwnerLoader(process.argv[2], process.argv[3]);
         try {
           if (${afterAdmission} && ${JSON.stringify(kind)} !== "lazy") await replace();
           const owner = await loadOwner("executor", ["admit"], []);
           if (${JSON.stringify(kind)} === "lazy") await replace();
           await owner.admit();
         } finally { loadOwner[Symbol.dispose]?.(); }`,
        pathToFileURL(path.resolve("scripts/lib/windows-repair-package.mts")).href,
        packageRoot,
        tarball,
        target,
        changed,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Installed module differs from the bound package");
    expect(result.stdout).not.toContain("UNVERIFIED_MODULE_EVALUATED");
  },
);

it.each(["alias", "self", "absolute"])(
  "rejects a post-admission %s escape into a separate npm dependency",
  async (kind) => {
    const specifier =
      kind === "alias"
        ? '"#dep"'
        : kind === "self"
          ? '"openclaw/dep"'
          : 'fileURLToPath(new URL("./target/index.cjs", import.meta.url))';
    const { packageRoot, tarball } = await fixture(
      {
        "executor-fixture.mjs": `import { createRequire } from "node:module"; import { fileURLToPath } from "node:url"; const value = createRequire(import.meta.url)(${specifier}); function admit() { return value; } export { admit };`,
        "target/index.cjs": 'module.exports = "original";',
      },
      {},
      {
        name: "openclaw",
        version: "0.0.0",
        imports: { "#dep": "./dist/target/index.cjs" },
        exports: { "./dep": "./dist/target/index.cjs" },
      },
    );
    const external = path.join(packageRoot, "node_modules", "external");
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(
      path.join(external, "index.cjs"),
      'console.log("UNVERIFIED_MODULE_EVALUATED"); module.exports = "changed";',
    );
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { rm, symlink } from "node:fs/promises";
       const { createPackagedOwnerLoader } = await import(process.argv[1]);
       const load = await createPackagedOwnerLoader(process.argv[2], process.argv[3]);
       try {
         await rm(process.argv[4], { recursive: true });
         await symlink(process.argv[5], process.argv[4], "junction");
         await load("executor", ["admit"], []);
       } finally { load[Symbol.dispose]?.(); }`,
        pathToFileURL(path.resolve("scripts/lib/windows-repair-package.mts")).href,
        packageRoot,
        tarball,
        path.join(packageRoot, "dist", "target"),
        external,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unbound installed package member");
    expect(result.stdout).not.toContain("UNVERIFIED_MODULE_EVALUATED");
  },
);

it("scopes import hooks to their loader lifetime while preserving external dependencies", async () => {
  const { packageRoot, tarball } = await fixture({
    "executor-fixture.mjs":
      'import { basename } from "node:path"; import external from "external"; async function admit() { return basename((await import("./implementation.mjs")).value) + external; } export { admit };',
    "implementation.mjs": 'import value from "./cjs.cjs"; export { value };',
    "cjs.cjs":
      'module.exports = require("./value") + require("./directory") + require("./data.json").suffix;',
    "value.js": 'module.exports = "path/";',
    "data.json": '{"suffix":"original"}',
    "directory/index.js": 'module.exports = "";',
  });
  const external = path.join(packageRoot, "node_modules", "external");
  await fs.mkdir(external, { recursive: true });
  await fs.writeFile(path.join(external, "package.json"), '{"name":"external","main":"index.cjs"}');
  await fs.writeFile(path.join(external, "index.cjs"), 'module.exports = "-external";');
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict";
     const { createPackagedOwnerLoader } = await import(process.argv[1]);
     const first = await createPackagedOwnerLoader(process.argv[2], process.argv[3]);
     const second = await createPackagedOwnerLoader(process.argv[2], process.argv[3]);
     try {
       first[Symbol.dispose]();
       assert.throws(() => first("executor", ["admit"], []), /loader is disposed/);
       const owner = await second("executor", ["admit"], []);
       assert.equal(await owner.admit(), "original-external");
     } finally { first[Symbol.dispose](); second[Symbol.dispose](); }`,
      pathToFileURL(path.resolve("scripts/lib/windows-repair-package.mts")).href,
      packageRoot,
      tarball,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
});

it.each(["added", "missing", "pending lifecycle", "nested dependency"])(
  "refuses %s installed files before loading an owner",
  async (kind) => {
    const { packageRoot, tarball } = await fixture({
      "executor-fixture.mjs": "function admit() {} export { admit };",
      "implementation.mjs": 'export const value = "original";',
    });
    if (kind === "pending lifecycle") {
      await fs.writeFile(
        path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH),
        "pending\n",
      );
    } else if (kind === "added") {
      await fs.writeFile(path.join(packageRoot, "dist", "unbound.mjs"), "export {};");
    } else if (kind === "nested dependency") {
      const injected = path.join(packageRoot, "dist", "node_modules", "injected");
      await fs.mkdir(injected, { recursive: true });
      await fs.writeFile(path.join(injected, "index.js"), "module.exports = 1;");
    } else {
      await fs.rm(path.join(packageRoot, "dist", "implementation.mjs"));
    }
    await expect(createPackagedOwnerLoader(packageRoot, tarball)).rejects.toThrow(
      kind === "missing" ? "Missing installed package members" : "Unbound installed package member",
    );
  },
);

it.each(["original", "changed", "missing", "added", "nested shadow"])(
  "authenticates %s bundled dependencies while allowing separate npm dependencies",
  async (kind) => {
    const dependency = "@fixture/bundled";
    const { packageRoot, tarball } = await fixture(
      { "executor-fixture.mjs": "function admit() {} export { admit };" },
      {
        [`${dependency}/package.json`]: '{"name":"@fixture/bundled","version":"1.0.0"}',
        [`${dependency}/index.js`]: "module.exports = 1;",
        "target/package.json": '{"name":"target","version":"1.0.0"}',
        "target/index.js": "module.exports = 1;",
      },
    );
    const external = path.join(packageRoot, "node_modules", "@fixture", "external");
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(path.join(external, "index.js"), "module.exports = 2;");
    const bundledRoot = path.join(packageRoot, "node_modules", dependency);
    if (kind === "changed") {
      await fs.writeFile(path.join(bundledRoot, "index.js"), "module.exports = 3;");
    } else if (kind === "missing") {
      await fs.rm(path.join(bundledRoot, "index.js"));
    } else if (kind === "added") {
      await fs.writeFile(path.join(bundledRoot, "extra.js"), "module.exports = 3;");
    } else if (kind === "nested shadow") {
      const shadow = path.join(bundledRoot, "node_modules", "target");
      await fs.mkdir(shadow, { recursive: true });
      await fs.writeFile(path.join(shadow, "index.js"), "module.exports = 3;");
    }
    const loaded = createPackagedOwnerLoader(packageRoot, tarball);
    if (kind === "original") {
      await expect(loaded).resolves.toBeTypeOf("function");
    } else {
      await expect(loaded).rejects.toThrow(
        kind === "changed"
          ? "Installed module differs from the bound package"
          : kind === "missing"
            ? "Missing installed package members"
            : "Unbound installed package member",
      );
    }
  },
);

it("authenticates a bundled package after npm pack and offline installation", async () => {
  const root = directories.make("windows-repair-npm-package-");
  const source = path.join(root, "source");
  const consumer = path.join(root, "consumer");
  const files = {
    "package.json": JSON.stringify({
      name: "proof-fixture",
      version: "1.0.0",
      type: "module",
      dependencies: { bundled: "1.0.0" },
      bundleDependencies: ["bundled"],
    }),
    "dist/executor-fixture.mjs": "function admit() {} export { admit };",
    "node_modules/bundled/package.json": '{"name":"bundled","version":"1.0.0"}',
    "node_modules/bundled/index.js": "module.exports = 1;",
  };
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(source, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  await fs.mkdir(consumer);
  await fs.writeFile(path.join(consumer, "package.json"), '{"private":true}');
  const tarball = path.join(root, "proof-fixture-1.0.0.tgz");
  for (const [cwd, args] of [
    [source, ["pack", "--pack-destination", root]],
    [consumer, ["install", "--no-audit", "--no-fund", tarball]],
  ] as const) {
    const npm = resolveNpmRunner({
      npmArgs: [...args, "--offline", "--ignore-scripts", "--cache", path.join(root, "npm-cache")],
    });
    const result = spawnSync(npm.command, npm.args, {
      cwd,
      env: npm.env,
      shell: npm.shell,
      windowsVerbatimArguments: npm.windowsVerbatimArguments,
      encoding: "utf8",
      timeout: 180_000,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  }
  const installed = path.join(consumer, "node_modules", "proof-fixture");
  await expect(createPackagedOwnerLoader(installed, tarball)).resolves.toBeTypeOf("function");
  await fs.writeFile(
    path.join(installed, "node_modules", "bundled", "index.js"),
    "module.exports = 2;",
  );
  await expect(createPackagedOwnerLoader(installed, tarball)).rejects.toThrow(
    "Installed module differs from the bound package",
  );
});

it("rejects a linked package directory before loading an owner", async () => {
  const { packageRoot, tarball } = await fixture({
    "executor-fixture.mjs": "function admit() {} export { admit };",
  });
  const originalDist = path.join(packageRoot, "..", "original-dist");
  await fs.rename(path.join(packageRoot, "dist"), originalDist);
  await fs.symlink(originalDist, path.join(packageRoot, "dist"), "junction");
  await expect(createPackagedOwnerLoader(packageRoot, tarball)).rejects.toThrow(
    "Unbound installed package member: dist",
  );
});

it.each(["absent", "ambiguous"])("refuses an %s packaged authority owner", async (shape) => {
  const files: Record<string, string> =
    shape === "absent"
      ? { "executor-other.mjs": "function different() {} export { different as a };" }
      : {
          "executor-first.mjs": "function admit() {} export { admit as a };",
          "executor-second.mjs": "function admit() {} export { admit as b };",
        };
  const { packageRoot, tarball } = await fixture(files);
  await expect(loadPackagedOwner(packageRoot, tarball, "executor", ["admit"], [])).rejects.toThrow(
    "Expected one packaged executor owner",
  );
});
