import fs from "node:fs/promises";
import path from "node:path";
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import {
  SKILL_LIBRARY_MAX_BUNDLE_BYTES,
  SKILL_LIBRARY_MAX_FILE_BYTES,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { extractArchive } from "../../infra/archive.js";
import { readResponseWithLimit } from "../../infra/http-body.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { SkillLibraryError } from "../skill-library-error.js";
import { SKILL_LIBRARY_MAX_PATH_COMPONENTS } from "./bundle.js";

const URL_HELP =
  "Use a public https://github.com/owner/repo/tree/ref/skill-path or blob/ref/skill-path/SKILL.md URL. For a ref containing /, encode its slashes as %2F in the ref segment.";
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

/** The first segment after tree/blob is the ref; %2F explicitly separates slash refs from paths. */
export function parseSkillRepositoryUrl(input: string) {
  const invalid = () => new SkillLibraryError("INVALID_BUNDLE", URL_HELP);
  let url: URL;
  let parts: string[];
  try {
    url = new URL(input);
    // Inspect the original path: URL normalizes dot segments before exposing pathname.
    const rawPath = /^https:\/\/[^/]+(\/[^?#]*)$/.exec(input)?.[1];
    if (!rawPath) {
      throw invalid();
    }
    parts = rawPath.replace(/\/$/, "").slice(1).split("/").map(decodeURIComponent);
  } catch {
    throw invalid();
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    parts.some(
      (part) =>
        !part ||
        part.includes("\\") ||
        /\p{Cc}/u.test(part) ||
        part.split("/").some((p) => !p || p === "." || p === ".."),
    )
  ) {
    throw invalid();
  }
  const [owner, repo, kind, ref, ...skillParts] = parts;
  if (
    !owner ||
    !repo ||
    !ref ||
    !/^[a-zA-Z0-9_.-]+$/.test(owner) ||
    !/^[a-zA-Z0-9_.-]+$/.test(repo) ||
    (kind !== "tree" && kind !== "blob") ||
    skillParts.some((part) => part.includes("/"))
  ) {
    throw invalid();
  }
  if (kind === "blob" && skillParts.pop() !== "SKILL.md") {
    throw invalid();
  }
  if (skillParts.length > SKILL_LIBRARY_MAX_PATH_COMPONENTS) {
    throw invalid();
  }
  return { owner, repo, ref, skillPath: skillParts.join("/") };
}

async function fetchPublicGitHubBytes(
  url: string,
  maxBytes: number,
  assertCurrent: () => void,
  accept = "application/octet-stream",
) {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    policy: { hostnameAllowlist: ["api.github.com", "codeload.github.com"] },
    maxRedirects: 0,
    timeoutMs: 60_000,
    beforeRequest: assertCurrent,
    init: { headers: { Accept: accept, "User-Agent": "OpenClaw" } },
  });
  try {
    if (!response.ok) {
      const hint =
        response.status === 404
          ? "Repository or ref not found; only public repositories are supported. For slash refs, encode / as %2F."
          : response.status === 403 || response.status === 429
            ? "GitHub rate limit or access restriction; try again later."
            : "Try again later.";
      throw new SkillLibraryError(
        "INVALID_BUNDLE",
        `GitHub download failed (HTTP ${response.status}). ${hint}`,
      );
    }
    try {
      return await readResponseWithLimit(response, maxBytes, { timeoutMs: 60_000 });
    } catch (error) {
      throw new SkillLibraryError(
        "INVALID_BUNDLE",
        `Cannot read GitHub response (limit ${maxBytes} bytes, 60 seconds): ${String(error)}`,
        undefined,
        { cause: error },
      );
    }
  } finally {
    await release();
  }
}

/** Downloads data only. No git checkout, hooks, package installation, or repository scripts. */
export async function withSkillRepository<T>(
  url: string,
  assertCurrent: () => void,
  onDirectory: (
    directory: string,
    repository: { url: string; ref: string; commit: string },
  ) => Promise<T>,
): Promise<T> {
  const source = parseSkillRepositoryUrl(url);
  const repository = `${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`;
  const metadata = await fetchPublicGitHubBytes(
    `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(source.ref)}`,
    1024,
    assertCurrent,
    "application/vnd.github.sha",
  );
  const commit = metadata.toString("utf8").trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new SkillLibraryError(
      "INVALID_BUNDLE",
      "GitHub did not return a valid repository commit.",
    );
  }
  const bytes = await fetchPublicGitHubBytes(
    `https://codeload.github.com/${repository}/zip/${commit}`,
    MAX_ARCHIVE_BYTES,
    assertCurrent,
  );
  assertCurrent();
  return withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-library-github-" },
    async ({ dir }) => {
      const archivePath = path.join(dir, "repository.zip");
      assertCurrent();
      await fs.writeFile(archivePath, bytes, { mode: 0o600 });
      const extractDir = path.join(dir, "skill");
      await fs.mkdir(extractDir);
      assertCurrent();
      try {
        await extractArchive({
          archivePath,
          destDir: extractDir,
          stripComponents: 1,
          timeoutMs: 120_000,
          limits: {
            maxArchiveBytes: MAX_ARCHIVE_BYTES,
            maxExtractedBytes: SKILL_LIBRARY_MAX_BUNDLE_BYTES,
            maxEntryBytes: SKILL_LIBRARY_MAX_FILE_BYTES,
            maxEntries: 20_000,
            maxEntryPathComponents: 64,
          },
          // Only the exact skill subtree is extracted; fs-safe still validates every archive path.
          entryFilter: (entry) => {
            const relative = entry.path.split("/").slice(1).join("/");
            return !source.skillPath ||
              relative === source.skillPath ||
              relative.startsWith(`${source.skillPath}/`)
              ? "extract"
              : "skip";
          },
          onFiltered: "skip-entry",
        });
      } catch (error) {
        throw new SkillLibraryError(
          "INVALID_BUNDLE",
          `Cannot extract GitHub skill: ${String(error)}`,
          undefined,
          { cause: error },
        );
      }
      assertCurrent();
      const directory = path.join(extractDir, source.skillPath);
      try {
        await fs.access(path.join(directory, "SKILL.md"));
      } catch {
        throw new SkillLibraryError(
          "INVALID_BUNDLE",
          "The selected GitHub directory does not contain SKILL.md. Choose the exact skill directory or its SKILL.md file.",
        );
      }
      return onDirectory(directory, {
        url: `https://github.com/${repository}`,
        ref: source.ref,
        commit,
      });
    },
  );
}
