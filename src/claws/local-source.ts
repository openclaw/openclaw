import { mkdir, stat } from "node:fs/promises";
import { tempWorkspace } from "@openclaw/fs-safe/temp";
import { extractArchive, resolvePackedRootDir } from "../infra/archive.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resolveUserPath } from "../utils.js";
import { readClawManifestFile } from "./reader.js";
import type { ClawReadResult } from "./types.js";

type LocalClawSource = AsyncDisposable & { claw: ClawReadResult };

/** Keep extracted sources alive until the one-way Add has copied all declared content. */
export async function resolveLocalClawSource(input: string): Promise<LocalClawSource> {
  const sourcePath = resolveUserPath(input);
  if (
    !/\.(?:tgz|tar\.gz)$/iu.test(sourcePath) ||
    (await stat(sourcePath).catch(() => undefined))?.isDirectory()
  ) {
    return {
      claw: await readClawManifestFile(sourcePath),
      async [Symbol.asyncDispose]() {},
    };
  }

  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-local-claw-",
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
    const claw = await readClawManifestFile(packageRoot);
    if (claw.ok && claw.source.kind !== "package") {
      throw new Error("A Claw archive must contain a package.json identifying its manifest.");
    }
    return { claw, [Symbol.asyncDispose]: dispose };
  } catch (error) {
    await dispose();
    return {
      claw: {
        ok: false,
        diagnostics: [
          {
            level: "error",
            phase: "parse",
            code: "invalid_claw_archive",
            path: "$",
            message: `Could not read Claw archive: ${String(error)}`,
          },
        ],
      },
      async [Symbol.asyncDispose]() {},
    };
  }
}
