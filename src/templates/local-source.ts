import { mkdir, stat } from "node:fs/promises";
import { tempWorkspace } from "@openclaw/fs-safe/temp";
import { extractArchive, resolvePackedRootDir } from "../infra/archive.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resolveUserPath } from "../utils.js";
import { readTemplateManifestFile } from "./reader.js";
import type { TemplateReadResult } from "./types.js";

type LocalTemplateSource = AsyncDisposable & { template: TemplateReadResult };

/** Keep extracted sources alive until the one-way Add has copied all declared content. */
export async function resolveLocalTemplateSource(input: string): Promise<LocalTemplateSource> {
  const sourcePath = resolveUserPath(input);
  if (
    !/\.(?:tgz|tar\.gz)$/iu.test(sourcePath) ||
    (await stat(sourcePath).catch(() => undefined))?.isDirectory()
  ) {
    return {
      template: await readTemplateManifestFile(sourcePath),
      async [Symbol.asyncDispose]() {},
    };
  }

  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-local-template-",
  });
  const dispose = async () => await workspace[Symbol.asyncDispose]();
  try {
    const extractDir = workspace.path("extract");
    await mkdir(extractDir);
    // Use the installer owner for bounded, staged extraction and traversal/link rejection.
    await extractArchive({
      archivePath: sourcePath,
      destDir: extractDir,
      timeoutMs: 30_000,
      durable: false,
    });
    const packageRoot = await resolvePackedRootDir(extractDir, { rootMarkers: ["package.json"] });
    const template = await readTemplateManifestFile(packageRoot);
    if (template.ok && template.source.kind !== "package") {
      throw new Error("A Template archive must contain a package.json identifying its manifest.");
    }
    return { template, [Symbol.asyncDispose]: dispose };
  } catch (error) {
    await dispose();
    return {
      template: {
        ok: false,
        diagnostics: [
          {
            level: "error",
            phase: "parse",
            code: "invalid_template_archive",
            path: "$",
            message: `Could not read Template archive: ${String(error)}`,
          },
        ],
      },
      async [Symbol.asyncDispose]() {},
    };
  }
}
