// Install extraction helpers validate and unpack skill archives into install roots.
import path from "node:path";
import { extractArchive as extractArchiveSafe } from "../../infra/archive.js";
import { sha256File } from "../../infra/directory-durability.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { root as fsSafeRoot } from "../../infra/fs-safe.js";

type ArchiveExtractResult = { stdout: string; stderr: string; code: number | null };

export async function extractSkillDownloadArchive(params: {
  archivePath: string;
  archiveType: string;
  targetDir: string;
  stripComponents?: number;
  timeoutMs: number;
}): Promise<ArchiveExtractResult> {
  const { archivePath, archiveType, targetDir, stripComponents, timeoutMs } = params;
  const kind =
    archiveType === "zip"
      ? "zip"
      : archiveType === "tar.gz"
        ? "tar"
        : archiveType === "tar.bz2"
          ? "tar-bzip2"
          : undefined;
  if (!kind) {
    return { stdout: "", stderr: `unsupported archive type: ${archiveType}`, code: null };
  }

  try {
    await extractArchiveSafe({
      archivePath,
      destDir: targetDir,
      timeoutMs,
      kind,
      stripComponents:
        typeof stripComponents === "number" && Number.isFinite(stripComponents)
          ? Math.max(0, Math.floor(stripComponents))
          : 0,
      tarGzip: kind === "tar" ? true : undefined,
      entryModes: kind === "tar-bzip2" ? "preserve" : "clamp",
      // System tar ignores umask as root; retain the installer's existing mode policy.
      entryUmask: kind === "tar-bzip2" ? (process.geteuid?.() === 0 ? 0 : process.umask()) : 0,
    });
    if (kind === "tar-bzip2") {
      const stagedRoot = await fsSafeRoot(targetDir);
      const validateReadable = async (directory: string): Promise<void> => {
        for await (const entry of stagedRoot.entries(directory ? `./${directory}` : "", {
          order: "filesystem",
          symlinks: "reject",
        })) {
          const member = path.join(directory, entry.name);
          if (entry.isSymbolicLink || (!entry.isFile && !entry.isDirectory)) {
            throw new Error(`archive staging contains a link or unsupported entry: ${entry.name}`);
          }
          if (entry.isDirectory) {
            await validateReadable(member);
          } else {
            await using handle = (
              await stagedRoot.open(path.join(stagedRoot.rootReal, member), {
                symlinks: "reject",
                hardlinks: "reject",
              })
            ).handle;
            // Read every byte before publication; no digest comparison authorizes the file.
            await sha256File(handle);
          }
        }
      };
      await validateReadable("");
    }
    return { stdout: "", stderr: "", code: 0 };
  } catch (err) {
    const message = formatErrorMessage(err);
    return { stdout: "", stderr: message, code: 1 };
  }
}
