import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Header } from "tar";
import { afterEach, expect, it, vi } from "vitest";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import {
  verifyPackageMember,
  type PackagedOwnerEvidence,
} from "../../scripts/lib/windows-repair-package.mts";
import { resolveNpmRunner } from "../../scripts/npm-runner.mts";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const nodeExecPath = requireNodeTool("node");
const ownerModule = (body = "", alias = "admit") =>
  `function admit() { ${body} } export { admit${alias === "admit" ? "" : ` as ${alias}`} };`;
const bundledModule = (name: string, contents: string, main?: string) => ({
  [`${name}/package.json`]: JSON.stringify({ name, version: "1.0.0", main }),
  [`${name}/${main ?? "index.js"}`]: contents,
});
const sha256 = (source: string) => createHash("sha256").update(source).digest("hex");
const ownerEvidence = (
  file: string,
  source: string,
  exports: Record<string, string>,
): PackagedOwnerEvidence => ({ file: `dist/${file}`, sha256: sha256(source), exports });

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
}

function runOwnerScript(packageRoot: string, tarball: string, script: string, args: string[] = []) {
  const program = `const { createPackagedOwnerLoader } = await import(process.argv[1]);
     const loadOwner = await createPackagedOwnerLoader(process.argv[2], process.argv[3]);
     try {
       ${script}
     } finally { loadOwner[Symbol.dispose](); }`;
  return spawnSync(
    nodeExecPath,
    [
      "--input-type=module",
      "--eval",
      program,
      pathToFileURL(path.resolve("scripts/lib/windows-repair-package.mts")).href,
      packageRoot,
      tarball,
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function expectUnverified(result: ReturnType<typeof runOwnerScript>, message: string) {
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(message);
  expect(result.stdout).not.toContain("UNVERIFIED_MODULE_EVALUATED");
}

async function fixture(
  files: Record<string, string>,
  bundled: Record<string, string> = {},
  manifest: { imports?: Record<string, string>; exports?: Record<string, string> } = {},
) {
  const root = directories.make("windows-repair-package-owner-");
  const packageRoot = path.join(root, "package");
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version: "0.0.0", ...manifest }),
  );
  await writeFiles(path.join(packageRoot, "dist"), files);
  await writeFiles(path.join(packageRoot, "node_modules"), bundled);
  const lifecycleMarker = path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
  await fs.writeFile(lifecycleMarker, "pending\n");
  const tarball = path.join(root, "candidate.tgz");
  execFileSync("tar", ["-czf", path.basename(tarball), "package"], {
    cwd: root,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  await fs.rm(lifecycleMarker);
  return packageFixture(packageRoot, tarball);
}

function packageFixture(root: string, tarball: string) {
  const file = (relative: string) => path.join(root, relative);
  const run = (script: string, args: string[] = []) => runOwnerScript(root, tarball, script, args);
  return {
    tarball,
    file,
    write: (relative: string, source: string) => writeFiles(root, { [relative]: source }),
    writeFiles: (files: Record<string, string>) => writeFiles(root, files),
    verify: (name: string) => verifyPackageMember(root, tarball, file(`dist/${name}`)),
    run,
    async inspect(
      stem = "",
      names: string[] = [],
    ): Promise<{
      loaderType: string;
      values: Record<string, unknown>;
      evidence: PackagedOwnerEvidence[];
    }> {
      const result = run(
        `const evidence = [];
         const values = {};
           if (process.argv[4]) {
             const names = JSON.parse(process.argv[5]);
             const owner = await loadOwner(process.argv[4], names, evidence);
             for (const name of names) values[name] = owner[name]();
           }
           process.stdout.write(JSON.stringify({ loaderType: typeof loadOwner, values, evidence }));`,
        [stem, JSON.stringify(names)],
      );
      if (result.error || result.status !== 0) {
        throw result.error ?? new Error(result.stderr || result.stdout);
      }
      return JSON.parse(result.stdout);
    },
  };
}

it("verifies a package member without system tar and rejects changed installed bytes", async () => {
  const source = "export const fixture = true;\n";
  const pkg = await fixture({ "member.mjs": source });
  vi.stubEnv("PATH", pkg.file("no-system-tools"));
  try {
    await expect(pkg.verify("member.mjs")).resolves.toEqual({
      file: "dist/member.mjs",
      sha256: sha256(source),
    });
    await pkg.write("dist/member.mjs", "export const fixture = false;\n");
    await expect(pkg.verify("member.mjs")).rejects.toThrow(
      "Installed module differs from the bound package",
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

it("rejects an oversized member before draining its missing body", async () => {
  const pkg = await fixture({ "member.mjs": "export {};\n" });
  const block = Buffer.alloc(512);
  new Header({
    path: "package/dist/member.mjs",
    type: "File",
    mode: 0o644,
    size: 32 * 1024 * 1024 + 1,
  }).encode(block);
  await fs.writeFile(pkg.tarball, block);
  await expect(pkg.verify("member.mjs")).rejects.toThrow(
    "regular package member within 33554432 bytes",
  );
});

it("accepts a highly compressible member below the existing byte ceiling", async () => {
  const source = "\0".repeat(31 * 1024 * 1024);
  const pkg = await fixture({ "member.node": source });
  expect((await fs.stat(pkg.tarball)).size).toBeLessThan(source.length / 1000);
  await expect(pkg.verify("member.node")).resolves.toEqual({
    file: "dist/member.node",
    sha256: sha256(source),
  });
});

it.each([
  { alias: "a", split: false },
  { alias: "$", split: true },
])(
  "loads named package owners through $alias with split chunks=$split",
  async ({ alias, split }) => {
    const admit = ownerModule('return "owned";', alias);
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
    const pkg = await fixture(files);
    const { evidence, values } = await pkg.inspect("executor", ["admit", "finish"]);
    expect(values).toMatchObject({ admit: "owned", finish: "finished" });
    const expected = [
      ownerEvidence(
        "executor-fixture.mjs",
        rootSource,
        split ? { admit: alias } : { admit: alias, finish: "f" },
      ),
    ];
    if (split) {
      expected.push(ownerEvidence("executor-finish.mjs", facade, { finish: "finish" }));
    }
    expect(evidence).toHaveLength(expected.length);
    expect(evidence).toEqual(expect.arrayContaining(expected));
  },
);

it("authenticates every selected chunk before importing any owner", async () => {
  const pkg = await fixture({
    "executor-first.mjs":
      'throw new Error("unverified code executed"); function admit() {} export { admit as a };',
    "executor-second.mjs": "function finish() {} export { finish as f };",
  });
  await pkg.write(
    "dist/executor-second.mjs",
    'function finish() { return "changed"; } export { finish as f };',
  );
  await expect(pkg.inspect("executor", ["admit", "finish"])).rejects.toThrow(
    "Installed module differs from the bound package",
  );
});

it.each(["owner", "static", "computed", "lazy", "bundled"])(
  "rejects post-admission %s replacement before evaluation",
  async (kind) => {
    const sources: Record<string, string> = {
      owner: ownerModule('return "original";'),
      static: 'import { value } from "./implementation.mjs"; ' + ownerModule("return value;"),
      computed:
        'const module = "./implementation.mjs"; const { value } = await import(module); ' +
        ownerModule("return value;"),
      lazy: 'async function admit() { return (await import("./implementation.mjs")).value; } export { admit };',
      bundled: 'import value from "bundled"; ' + ownerModule("return value;"),
    };
    const pkg = await fixture(
      {
        "executor-fixture.mjs": sources[kind]!,
        "implementation.mjs": 'export const value = "original";',
      },
      kind === "bundled"
        ? bundledModule("bundled", 'module.exports = "original";', "index.cjs")
        : {},
    );
    const target = pkg.file(
      kind === "bundled"
        ? "node_modules/bundled/index.cjs"
        : `dist/${kind === "owner" ? "executor-fixture" : "implementation"}.mjs`,
    );
    const changed =
      'console.log("UNVERIFIED_MODULE_EVALUATED"); ' +
      (kind === "owner"
        ? ownerModule('return "changed";')
        : kind === "bundled"
          ? 'module.exports = "changed";'
          : 'export const value = "changed";');
    const result = pkg.run(
      `const { writeFile } = await import("node:fs/promises");
         const replace = () => writeFile(process.argv[4], process.argv[5]);
           if (${JSON.stringify(kind)} !== "lazy") await replace();
           const owner = await loadOwner("executor", ["admit"], []);
           if (${JSON.stringify(kind)} === "lazy") await replace();
           await owner.admit();`,
      [target, changed],
    );
    expectUnverified(result, "Installed module differs from the bound package");
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
    const pkg = await fixture(
      {
        "executor-fixture.mjs": `import { createRequire } from "node:module"; import { fileURLToPath } from "node:url"; const value = createRequire(import.meta.url)(${specifier}); function admit() { return value; } export { admit };`,
        "target/index.cjs": 'module.exports = "original";',
      },
      {},
      {
        imports: { "#dep": "./dist/target/index.cjs" },
        exports: { "./dep": "./dist/target/index.cjs" },
      },
    );
    const external = pkg.file("node_modules/external");
    await pkg.write(
      "node_modules/external/index.cjs",
      'console.log("UNVERIFIED_MODULE_EVALUATED"); module.exports = "changed";',
    );
    const result = pkg.run(
      `const { rm, symlink } = await import("node:fs/promises");
         await rm(process.argv[4], { recursive: true });
         await symlink(process.argv[5], process.argv[4], "junction");
         await loadOwner("executor", ["admit"], []);`,
      [pkg.file("dist/target"), external],
    );
    expectUnverified(result, "Unbound installed package member");
  },
);

it("scopes import hooks to their loader lifetime while preserving external dependencies", async () => {
  const pkg = await fixture({
    "executor-fixture.mjs":
      'import { basename } from "node:path"; import external from "external"; async function admit() { return basename((await import("./implementation.mjs")).value) + external; } export { admit };',
    "implementation.mjs": 'import value from "./cjs.cjs"; export { value };',
    "cjs.cjs":
      'module.exports = require("./value") + require("./directory") + require("./data.json").suffix;',
    "value.js": 'module.exports = "path/";',
    "data.json": '{"suffix":"original"}',
    "directory/index.js": 'module.exports = "";',
  });
  await pkg.writeFiles({
    "node_modules/external/package.json": '{"name":"external","main":"index.cjs"}',
    "node_modules/external/index.cjs": 'module.exports = "-external";',
  });
  const result = pkg.run(
    `const { default: assert } = await import("node:assert/strict");
     const second = await createPackagedOwnerLoader(process.argv[2], process.argv[3]);
     try {
       loadOwner[Symbol.dispose]();
       assert.throws(() => loadOwner("executor", ["admit"], []), /loader is disposed/);
       const owner = await second("executor", ["admit"], []);
       assert.equal(await owner.admit(), "original-external");
     } finally { second[Symbol.dispose](); }`,
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
});

it.each([
  ["missing", "Missing installed package members"],
  ["pending lifecycle", "Unbound installed package member"],
  ["nested dependency", "Unbound installed package member"],
  ["missing bundled", "Missing installed package members"],
  ["bundled nested shadow", "Unbound installed package member"],
  ["linked directory", "Unbound installed package member: dist"],
] as const)("refuses %s installed files before loading an owner", async (kind, error) => {
  const bundled = kind === "missing bundled" || kind === "bundled nested shadow";
  const pkg = await fixture(
    {
      "executor-fixture.mjs": ownerModule(),
      ...(!bundled && kind !== "linked directory"
        ? { "implementation.mjs": 'export const value = "original";' }
        : {}),
    },
    bundled
      ? {
          ...bundledModule("@fixture/bundled", "module.exports = 1;"),
          ...bundledModule("target", "module.exports = 1;"),
        }
      : {},
  );
  if (bundled) {
    await pkg.writeFiles({
      "node_modules/@fixture/external/index.js": "module.exports = 2;",
    });
  }
  if (kind === "missing" || kind === "missing bundled") {
    await fs.rm(
      pkg.file(bundled ? "node_modules/@fixture/bundled/index.js" : "dist/implementation.mjs"),
    );
  } else if (kind === "linked directory") {
    const originalDist = pkg.file("../original-dist");
    await fs.rename(pkg.file("dist"), originalDist);
    await fs.symlink(originalDist, pkg.file("dist"), "junction");
  } else if (kind === "pending lifecycle") {
    await pkg.write(PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH, "pending\n");
  } else {
    const injected = bundled
      ? "node_modules/@fixture/bundled/node_modules/target"
      : "dist/node_modules/injected";
    await pkg.writeFiles({
      [`${injected}/index.js`]: bundled ? "module.exports = 3;" : "module.exports = 1;",
    });
  }
  await expect(pkg.inspect()).rejects.toThrow(error);
});

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
    "dist/executor-fixture.mjs": ownerModule(),
    "node_modules/bundled/package.json": '{"name":"bundled","version":"1.0.0"}',
    "node_modules/bundled/index.js": "module.exports = 1;",
  };
  await writeFiles(source, files);
  await fs.mkdir(consumer);
  await fs.writeFile(path.join(consumer, "package.json"), '{"private":true}');
  const tarball = path.join(root, "proof-fixture-1.0.0.tgz");
  for (const [cwd, args] of [
    [source, ["pack", "--pack-destination", root]],
    [consumer, ["install", "--no-audit", "--no-fund", tarball]],
  ] as const) {
    const npm = resolveNpmRunner({
      execPath: nodeExecPath,
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
  const installed = packageFixture(path.join(consumer, "node_modules", "proof-fixture"), tarball);
  await expect(installed.inspect()).resolves.toMatchObject({
    loaderType: "function",
  });
  await installed.write("node_modules/bundled/index.js", "module.exports = 2;");
  await expect(installed.inspect()).rejects.toThrow(
    "Installed module differs from the bound package",
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
  const pkg = await fixture(files);
  await expect(pkg.inspect("executor", ["admit"])).rejects.toThrow(
    "Expected one packaged executor owner",
  );
});
