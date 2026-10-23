import { afterEach, expect, it, vi } from "vitest";
import type { UpdateCandidatePluginTreePlan } from "./update-candidate-plugin-tree-schema.js";
import * as pluginTrees from "./update-candidate-plugin-tree.js";
import {
  prepareRetainedRuntimeFiles,
  RetainedRuntimeFilesSchema,
} from "./update-retained-runtime-files.js";
import * as runtimeTree from "./update-retained-runtime-tree.js";

afterEach(() => vi.restoreAllMocks());

it("keeps a large materialized runtime's reply within the worker capture budget", async () => {
  const sourceRoot = "/opt/runtime";
  const privateRoot = "/var/tmp/retained-runtime";
  const packageRoot =
    `${sourceRoot}/node_modules/.pnpm/@example+provider@1.0.0_peer-runtime@2.0.0/` +
    "node_modules/@example/provider/dist/generated";
  const files = [
    `${sourceRoot}/package.json`,
    `${packageRoot}/quoted-"雪".json`,
    ...Array.from(
      { length: 160_000 },
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
  // The real worker serializes this producer's result, before the parent's schema
  // can discard fields. This inventory exceeded the unchanged 64 MiB stdout cap.
  const captureLimit = 64 * 1024 * 1024;
  const serialized = JSON.stringify(result);
  expect(Buffer.byteLength(JSON.stringify({ plan, ...metrics }))).toBeGreaterThan(captureLimit);
  expect(Buffer.byteLength(serialized)).toBeLessThan(captureLimit);
  expect(RetainedRuntimeFilesSchema.parse(JSON.parse(serialized))).toEqual({
    relocations,
    files,
    entries: files.length + 2,
    estimatedBytes: (files.length + 2) * 4096,
    ...metrics,
  });
});
