import type { Readable, Writable } from "node:stream";
import { parentPort, type MessagePort } from "node:worker_threads";

// Describe the public artifact without pulling plugin source into core's type graph.
type MemoryWorkerApi = {
  serveLocalMemoryWatches: (port: MessagePort) => Promise<void>;
  serveMemoryFiles: (options: {
    workspace: string;
    input: Readable;
    output: Writable;
    watch?: boolean;
  }) => Promise<void>;
};

try {
  // Stdout belongs to file IPC, including during plugin initialization.
  console.log = console.info = (...values: unknown[]) => console.error(...values);
  const { loadBundledPluginPublicArtifactModuleSync } =
    await import("../plugins/public-surface-loader.js");
  const api = loadBundledPluginPublicArtifactModuleSync<MemoryWorkerApi>({
    dirName: "memory-core",
    artifactBasename: "worker-api.js",
  });
  if (parentPort) {
    await api.serveLocalMemoryWatches(parentPort);
  } else {
    const [mode, workspace, ...extra] = process.argv.slice(2);
    if ((mode !== "--files" && mode !== "--watch-files") || !workspace || extra.length) {
      throw new Error("Memory file worker requires --files or --watch-files <workspace>");
    }
    await api.serveMemoryFiles({
      workspace,
      input: process.stdin,
      output: process.stdout,
      watch: mode === "--watch-files",
    });
  }
} catch (error) {
  process.stderr.write(`Memory file worker failed: ${String(error)}\n`);
  process.exitCode = 1;
  parentPort?.close();
}
