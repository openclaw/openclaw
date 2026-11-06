import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSealedRuntimeProcessEntrypoints } from "../infra/runtime-process-manifest.js";
import type { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { runtimeNeedsTypeScriptLoader } from "../infra/runtime-worker-url.js";

/** Give fixture workers the same filenames as a sealed deployment without replacing its resolver. */
export async function writeSealedRuntimeProcessFixture(
  directory: string,
  group: Parameters<typeof createSealedRuntimeProcessEntrypoints>[0],
  targets: Partial<Record<Parameters<typeof resolveRuntimeProcessEntrypointUrl>[0], URL>>,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const bootstrap = pathToFileURL(path.join(directory, "fixture.mjs")).href;
  for (const { name, url } of createSealedRuntimeProcessEntrypoints(group, bootstrap)) {
    const target = targets[name];
    if (!target) {
      continue;
    }
    const preload = runtimeNeedsTypeScriptLoader(fileURLToPath(target))
      ? `await import(${JSON.stringify(import.meta.resolve("tsx/esm"))});\n`
      : "";
    await writeFile(
      fileURLToPath(url),
      `${preload}await import(${JSON.stringify(target.href)});\n`,
    );
  }
  return bootstrap;
}
