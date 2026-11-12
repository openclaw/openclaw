import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { UpdateCandidatePluginTreePlan } from "./update-candidate-plugin-tree-schema.js";
import * as pluginTrees from "./update-candidate-plugin-tree.js";
import {
  prepareRetainedRuntimeFiles,
  readRetainedRuntimeFileList,
  RetainedRuntimeFilesSchema,
} from "./update-retained-runtime-files.js";
import * as runtimeTree from "./update-retained-runtime-tree.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("keeps a materialized runtime's reply independent of its file count", async () => {
  const sourceRoot = "/opt/runtime";
  const privateRoot = fs.realpathSync(dirs.make("retained-runtime-"));
  const packageRoot =
    `${sourceRoot}/node_modules/.pnpm/@example+provider@1.0.0_peer-runtime@2.0.0/` +
    "node_modules/@example/provider/dist/generated";
  const files = [
    `${sourceRoot}/package.json`,
    `${packageRoot}/quoted-"雪".json`,
    ...Array.from(
      // A pnpm global virtual store closure reaches ~750k files, beyond 64 MiB of paths.
      { length: 400_000 },
      (_, index) => `${packageRoot}/context-provider-schema-${String(index).padStart(6, "0")}.d.ts`,
    ),
  ];
  const metadata = { size: 4096, mode: 0o100644, dev: "2050" };
  const destinationRoot = `${privateRoot}/tree/2f/opt/runtime`;
  const relocations = [{ sourceRoot, destinationRoot }];
  const plan: UpdateCandidatePluginTreePlan = {
    privateRoot,
    candidateRoot: destinationRoot,
    bytes: (files.length + 2) * 4096,
    entries: [
      { ...metadata, kind: "directory", path: packageRoot, mode: 0o40755, ino: "1" },
      ...files.map((file, index) => ({
        ...metadata,
        kind: "file" as const,
        path: file,
        ino: String(index + 3),
        birthtimeNs: "1720000000000000000",
        mtimeNs: "1720000000000000000",
        ctimeNs: "1720000000000000000",
        uid: "1000",
        gid: "1000",
        sha256: "a".repeat(64),
      })),
      {
        ...metadata,
        kind: "symlink",
        path: `${sourceRoot}/node_modules/provider`,
        ino: "2",
        link: packageRoot,
        linkType: "junction",
      },
    ],
    copies: [[sourceRoot, destinationRoot]],
    relocations,
    hostLinks: [],
    aliases: [],
    moduleBindings: [],
    edges: [],
  };
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  vi.spyOn(pluginTrees, "prepareUpdateCandidatePluginTrees").mockImplementation(async () => {
    clock.mockReturnValue(125);
    return plan;
  });
  vi.spyOn(runtimeTree, "linkUpdateCandidatePluginTrees").mockImplementation(async (input) => {
    expect(input).toBe(plan);
    clock.mockReturnValue(175);
    return { linked: files.length - 1, copied: 1 };
  });

  const result = await prepareRetainedRuntimeFiles({
    privateRoot,
    sourceRoot,
    roots: [sourceRoot],
    retainedDependencyRoot: sourceRoot,
  });
  const metrics = { inventoryMs: 25, materializationMs: 50, linked: files.length - 1, copied: 1 };
  // The real worker serializes this producer's result to a capped stdout; its size
  // must not scale with the file inventory, which stays in private storage.
  const serialized = JSON.stringify(result);
  expect(Buffer.byteLength(serialized)).toBeLessThan(4096);
  const reply = RetainedRuntimeFilesSchema.parse(JSON.parse(serialized));
  expect(reply).toEqual({
    relocations,
    fileCount: files.length,
    entries: files.length + 2,
    estimatedBytes: (files.length + 2) * 4096,
    ...metrics,
  });
  expect(await readRetainedRuntimeFileList(privateRoot, { fileCount: files.length })).toEqual(
    files,
  );
});

it("refuses a retained file list that does not match the worker's reply", async () => {
  const privateRoot = fs.realpathSync(dirs.make("retained-runtime-"));
  vi.spyOn(pluginTrees, "prepareUpdateCandidatePluginTrees").mockResolvedValue({
    privateRoot,
    candidateRoot: privateRoot,
    bytes: 1,
    entries: [
      {
        kind: "file",
        path: "/opt/runtime/package.json",
        size: 1,
        mode: 0o100644,
        dev: "1",
        ino: "2",
        birthtimeNs: "1",
        mtimeNs: "1",
        ctimeNs: "1",
        uid: "1",
        gid: "1",
        sha256: "a".repeat(64),
      },
    ],
    copies: [],
    relocations: [],
    hostLinks: [],
    aliases: [],
    moduleBindings: [],
    edges: [],
  });
  vi.spyOn(runtimeTree, "linkUpdateCandidatePluginTrees").mockResolvedValue({
    linked: 1,
    copied: 0,
  });
  const reply = RetainedRuntimeFilesSchema.parse(
    await prepareRetainedRuntimeFiles({
      privateRoot,
      sourceRoot: "/opt/runtime",
      roots: ["/opt/runtime"],
      retainedDependencyRoot: "/opt/runtime",
    }),
  );
  if ("unusableReason" in reply) {
    throw new Error(reply.unusableReason);
  }
  await expect(readRetainedRuntimeFileList(privateRoot, { fileCount: 2 })).rejects.toThrow(
    "Retained runtime file list does not match its worker reply",
  );
  await expect(readRetainedRuntimeFileList(privateRoot, reply)).resolves.toEqual([
    "/opt/runtime/package.json",
  ]);
});

// Private umasks (077) make every installed file owner-private. Package recovery
// state stays copied; dependency package bytes are linked whatever their mode.
it.skipIf(process.platform === "win32").each([
  ["git checkout", ""],
  ["global package", "lib/node_modules/openclaw"],
] as const)("links owner-private dependency files in a %s", async (_name, packagePath) => {
  const prefix = fs.realpathSync(dirs.make("retained-runtime-private-source-"));
  const sourceRoot = path.join(prefix, packagePath);
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { mode: 0o600 });
    return file;
  };
  const inSource = (relative: string, content: string) =>
    write(path.join(sourceRoot, relative), content);
  inSource("package.json", JSON.stringify({ name: "openclaw", type: "module" }));
  const own = inSource("dist/index.js", "import 'dep';\n");
  const dependency = inSource("node_modules/dep/index.js", "export default 1;\n");
  inSource("node_modules/dep/package.json", JSON.stringify({ name: "dep", main: "index.js" }));
  const scoped = inSource("node_modules/@scope/pkg/index.js", "export default 2;\n");
  inSource("node_modules/@scope/pkg/package.json", JSON.stringify({ name: "@scope/pkg" }));
  const pnpm = inSource(
    "node_modules/.pnpm/hoisted@1.0.0/node_modules/hoisted/index.js",
    "export default 3;\n",
  );
  inSource(
    "node_modules/.pnpm/hoisted@1.0.0/node_modules/hoisted/package.json",
    JSON.stringify({ name: "hoisted" }),
  );
  fs.symlinkSync(
    path.join(sourceRoot, "node_modules/.pnpm/hoisted@1.0.0/node_modules/hoisted"),
    path.join(sourceRoot, "node_modules/hoisted"),
  );
  const control = inSource("node_modules/.package-lock.json", "{}\n");
  const privateRoot = path.join(fs.realpathSync(dirs.make("retained-runtime-private-")), "r");
  const result = await prepareRetainedRuntimeFiles({
    privateRoot,
    sourceRoot,
    roots: ["package.json", "dist", "node_modules"].map((name) => path.join(sourceRoot, name)),
    retainedDependencyRoot: sourceRoot,
  });
  expect(result).not.toHaveProperty("unusableReason");
  const nlink = (file: string) => fs.lstatSync(file).nlink;
  expect([nlink(dependency), nlink(scoped), nlink(pnpm)]).toEqual([2, 2, 2]);
  // The package's own private bytes, including a global install's dist under
  // node_modules, and package-manager control entries keep nlink=1.
  expect([nlink(own), nlink(control)]).toEqual([1, 1]);
  expect(result).toMatchObject({ linked: 3 });
});
