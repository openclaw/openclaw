import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

/** Keep native SDK consumers on the invocation's verified, current-source graph. */
export function createCompiledSdkHost(
  entrypoint: Parameters<typeof resolveRuntimeWorkerUrl>[0],
  makeTempDir: (prefix: string) => string,
): string | undefined {
  const artifact = fileURLToPath(resolveRuntimeWorkerUrl(entrypoint));
  // Standalone and watch-mode Vitest deliberately retain source declarations.
  if (path.extname(artifact) !== ".js") {
    return undefined;
  }
  const hostRoot = makeTempDir("openclaw-sdk-host-");
  fs.cpSync(path.dirname(path.dirname(artifact)), path.join(hostRoot, "dist"), {
    recursive: true,
  });
  fs.copyFileSync(
    path.resolve(import.meta.dirname, "../../package.json"),
    path.join(hostRoot, "package.json"),
  );
  fs.mkdirSync(path.join(hostRoot, "src"));
  fs.mkdirSync(path.join(hostRoot, "extensions"));
  fs.symlinkSync(path.resolve("node_modules"), path.join(hostRoot, "node_modules"), "junction");
  return hostRoot;
}
