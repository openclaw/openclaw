import fs from "node:fs";
import path from "node:path";
import {
  SKILL_LIBRARY_MAX_FILE_BYTES,
  type SkillLibrarySelection,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { openRootFileSync, readFileDescriptorBoundedSync } from "../../infra/boundary-file-read.js";
import { serializeNativeErrorResponse } from "../../infra/native-error-response.js";
import {
  parseSkillFrontmatter,
  resolveSkillInvocationPolicy,
  resolveSkillManifestMetadata,
} from "../loading/frontmatter.js";
import { materializeSkill } from "../loading/skill-materializer.js";
import { SkillLibraryError } from "../skill-library-error.js";
import type { SkillEntry } from "../types.js";
import { readSkillLibraryManifestTreeOnWorker, skillLibraryRevisionDir } from "./bundle.js";
import type {
  SkillLibraryFilesystemInput,
  SkillLibraryFilesystemOutput,
} from "./filesystem.contract.js";

export function materializeSkillLibrarySelection(
  selections: readonly SkillLibrarySelection[],
  revisions: Array<{ description: string } | undefined>,
  env: NodeJS.ProcessEnv | undefined,
): SkillEntry[] {
  return selections.map((selection, index) => {
    const revision = revisions[index];
    if (!revision) {
      throw new SkillLibraryError(
        "NOT_FOUND",
        "A pinned skill revision is unavailable; restore the library artifact or detach it explicitly.",
      );
    }
    const baseDir = skillLibraryRevisionDir(selection.skillId, selection.revision, env);
    const filePath = path.join(baseDir, "SKILL.md");
    const opened = openRootFileSync({
      absolutePath: filePath,
      rootPath: baseDir,
      boundaryLabel: "skill library revision",
      maxBytes: SKILL_LIBRARY_MAX_FILE_BYTES,
      rejectHardlinks: true,
      symlinks: "reject",
    });
    if (!opened.ok) {
      throw new SkillLibraryError(
        "INVALID_BUNDLE",
        "Pinned skill instructions could not be read; restore the library artifact or detach it explicitly.",
        undefined,
        { cause: opened.error },
      );
    }
    let content: string;
    try {
      content = readFileDescriptorBoundedSync(opened.fd, SKILL_LIBRARY_MAX_FILE_BYTES).toString(
        "utf8",
      );
    } finally {
      fs.closeSync(opened.fd);
    }
    const frontmatter = parseSkillFrontmatter(content);
    const metadata = resolveSkillManifestMetadata(frontmatter);
    const invocation = resolveSkillInvocationPolicy(frontmatter);
    const name = selection.name;
    return {
      skill: materializeSkill({
        content,
        frontmatter,
        name,
        description: revision.description,
        baseDir,
        filePath,
        source: "openclaw-library",
        sourceOptions: { source: "openclaw-library" },
      }),
      frontmatter,
      invocation,
      // Untrusted frontmatter can constrain executable eligibility, but cannot claim global credentials/config.
      metadata: {
        skillKey: name,
        os: metadata?.os,
        requires: metadata?.requires,
      },
      disableCommandDispatch: true,
      syncSourceDir: baseDir,
      syncDirName: `library-${selection.skillId}-${selection.revision}`,
    } satisfies SkillEntry;
  });
}

export async function executeSkillLibraryFilesystemTask(
  input: SkillLibraryFilesystemInput,
): Promise<SkillLibraryFilesystemOutput> {
  try {
    if (input.kind === "selection") {
      return {
        kind: "selection",
        entries: materializeSkillLibrarySelection(input.selections, input.revisions, {
          OPENCLAW_STATE_DIR: input.stateDir,
        }),
      };
    }
    return {
      kind: "manifest",
      files: await readSkillLibraryManifestTreeOnWorker(
        input.directory,
        input.manifestJson,
        input.revision,
      ),
    };
  } catch (error) {
    return {
      kind: "error",
      error: serializeNativeErrorResponse(error),
      libraryCode: error instanceof SkillLibraryError ? error.code : undefined,
    };
  }
}
