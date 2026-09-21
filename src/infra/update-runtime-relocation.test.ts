import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  prepareGitRuntimePromotion,
  prepareGitRuntimePromotionSource,
} from "./update-runner-git-runtime.js";
import { relocateRuntimeSymlink } from "./update-runtime-relocation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function relativeDirectoryLink(file: string, target: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.symlink(path.relative(path.dirname(file), target), file, "dir");
}

async function writeDependencyGraph(root: string, store = "node_modules/.pnpm") {
  const consumer = path.join(root, store, "a-consumer", "node_modules", "a-consumer");
  const dependency = path.join(root, store, "z-dependency", "node_modules", "z-dependency");
  await fs.mkdir(consumer, { recursive: true });
  await fs.mkdir(dependency, { recursive: true });
  await fs.writeFile(path.join(dependency, "index.js"), "module.exports = 'retained';\n");
  await fs.writeFile(
    path.join(consumer, "index.js"),
    "module.exports = require('z-dependency');\n",
  );
  const transitive = path.join(consumer, "..", "z-dependency");
  await relativeDirectoryLink(transitive, dependency);
  await relativeDirectoryLink(path.join(root, "node_modules", "a-consumer"), consumer);
  await fs.writeFile(
    path.join(root, "node_modules", ".modules.yaml"),
    JSON.stringify({
      virtualStoreDir: path.relative(path.join(root, "node_modules"), path.join(root, store)),
    }),
  );
  return { consumer, dependency, transitive };
}

const enumerateRuntime = async () => ({ code: 0, stdout: "node_modules/\0", stderr: "" });

describe("Windows runtime directory-link promotion", () => {
  it("repairs copied directory type even when relative target text is unchanged", async () => {
    const root = tempDirs.make("openclaw-runtime-links-");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const staged = path.join(root, "staged");
    for (const directory of [source, destination, staged]) {
      await fs.mkdir(path.join(directory, "dependency"), { recursive: true });
    }
    await relativeDirectoryLink(path.join(source, "link"), path.join(source, "dependency"));
    // Native fs.cp can infer "file" before the relative target is copied.
    await fs.symlink("dependency", path.join(staged, "link"), "file");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await relocateRuntimeSymlink(
      path.join(staged, "link"),
      path.join(source, "link"),
      path.join(destination, "link"),
      [{ sourceRoot: source, destinationRoot: destination }],
    );
    expect(await fs.readlink(path.join(staged, "link"))).toBe(path.join(destination, "dependency"));
    expect((await fs.stat(path.join(staged, "link"))).isDirectory()).toBe(true);
  });

  it("keeps transitive dependencies usable after activation and source cleanup", async () => {
    const root = tempDirs.make("openclaw-runtime-promotion-");
    const source = path.join(root, "candidate");
    const destination = path.join(root, "live");
    const graph = await writeDependencyGraph(source);
    await fs.mkdir(destination);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const promotion = await prepareGitRuntimePromotion(
      destination,
      source,
      enumerateRuntime,
      5000,
      root,
    );
    try {
      await promotion.activate();
      await fs.rm(source, { recursive: true, force: true });
      const promoted = path.join(destination, path.relative(source, graph.transitive));
      expect(await fs.readlink(promoted)).toBe(
        path.join(destination, path.relative(source, graph.dependency)),
      );
      expect(await fs.readFile(path.join(promoted, "index.js"), "utf8")).toContain("retained");
    } finally {
      await promotion.cleanup();
    }
  });

  it.each(["node_modules/.pnpm", ".candidate-store"])(
    "prepares candidate-owned %s links for the published driver without traversing external stores",
    async (store) => {
      const root = tempDirs.make("openclaw-runtime-source-");
      const source = path.join(root, "candidate");
      const graph = await writeDependencyGraph(source, store);
      const external = path.join(root, "external");
      await fs.mkdir(path.join(external, "dependency"), { recursive: true });
      await relativeDirectoryLink(path.join(external, "link"), path.join(external, "dependency"));
      await relativeDirectoryLink(path.join(source, "node_modules", "external"), external);
      const originalExternal = await fs.readlink(path.join(external, "link"));
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      await prepareGitRuntimePromotionSource(source, enumerateRuntime, 5000);
      expect(await fs.readlink(graph.transitive)).toBe(graph.dependency);
      expect(await fs.readlink(path.join(source, "node_modules", "a-consumer"))).toBe(
        graph.consumer,
      );
      expect(await fs.readlink(path.join(source, "node_modules", "external"))).toBe(external);
      expect(await fs.readlink(path.join(external, "link"))).toBe(originalExternal);
      expect(await fs.readFile(path.join(graph.transitive, "index.js"), "utf8")).toContain(
        "retained",
      );
    },
  );

  it("leaves ordinary POSIX candidate links alone", async () => {
    const root = tempDirs.make("openclaw-runtime-posix-");
    const graph = await writeDependencyGraph(root);
    const before = await fs.readlink(graph.transitive);
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const enumerate = vi.fn(enumerateRuntime);
    await prepareGitRuntimePromotionSource(root, enumerate, 5000);
    expect(enumerate).not.toHaveBeenCalled();
    expect(await fs.readlink(graph.transitive)).toBe(before);
  });
});
