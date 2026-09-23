import type { Readable, Writable } from "node:stream";

// Describe the public artifact without pulling plugin source into core's type graph.
type MemoryWorkerApi = {
  serveMemoryFiles: (options: {
    workspace: string;
    input: Readable;
    output: Writable;
    watch?: boolean;
  }) => Promise<void>;
};

try {
  const [mode, workspace, ...extra] = process.argv.slice(2);
  if ((mode !== "--files" && mode !== "--watch-files") || !workspace || extra.length) {
    throw new Error("Memory file worker requires --files or --watch-files <workspace>");
  }
  // Stdout belongs to file IPC, including during plugin initialization.
  console.log = console.info = (...values: unknown[]) => console.error(...values);
  const { loadBundledPluginPublicArtifactModuleSync } =
    await import("../plugins/public-surface-loader.js");
  const { serveMemoryFiles } = loadBundledPluginPublicArtifactModuleSync<MemoryWorkerApi>({
    dirName: "memory-core",
    artifactBasename: "worker-api.js",
  });
  await serveMemoryFiles({
    workspace,
    input: process.stdin,
    output: process.stdout,
    watch: mode === "--watch-files",
  });
} catch (error) {
  process.stderr.write(`Memory file worker failed: ${String(error)}\n`);
  process.exitCode = 1;
}
