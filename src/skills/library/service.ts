import { randomUUID } from "node:crypto";
import {
  validateSkillsLibrarySaveParams,
  type SkillsLibraryListParams,
  type SkillsLibraryListResult,
  type SkillsLibrarySaveParams,
  type SkillsLibraryMutateParams,
  type SkillsLibraryReceipt,
  type SkillsLibraryReadResult,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { evaluateSkillInstallPolicy } from "../../plugins/install-security-scan.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { SkillLibraryError } from "../skill-library-error.js";
import {
  assertProposalContainsNoLiteralSecrets,
  scanProposalBundle,
} from "../workshop/proposal-scan.js";
import {
  decodeSkillLibraryFile,
  prepareSkillLibraryBundle,
  readSkillLibraryManifestTree,
  skillLibraryRevisionDir,
  stageSkillLibraryBundle,
} from "./bundle.js";
import { captureSkillLibraryAccess } from "./store-access.js";
import { assertSkillLibraryRevision, type SkillLibraryAuthority } from "./store.js";
export { skillLibraryReceipt } from "./receipt.js";
/** Prepared at human ingress without host database access. */
export async function resolveSkillLibraryPresentation(
  authority: SkillLibraryAuthority,
  options: OpenClawStateDatabaseOptions = {},
) {
  return (await captureSkillLibraryAccess(authority, options).read("presentation", undefined))
    .value;
}

export async function listSkillLibrary(
  authority: SkillLibraryAuthority,
  params: SkillsLibraryListParams = {},
  options: OpenClawStateDatabaseOptions = {},
): Promise<SkillsLibraryListResult> {
  return (await captureSkillLibraryAccess(authority, options).read("list", params)).value;
}

export async function readSkillLibrary(
  authority: SkillLibraryAuthority,
  skillId: string,
  revision?: string,
  options: OpenClawStateDatabaseOptions = {},
  selected?: { revision: string; assertSessionAccess: () => void },
): Promise<SkillsLibraryReadResult> {
  const access = captureSkillLibraryAccess(authority, options);
  selected?.assertSessionAccess();
  const prepared = await access.read("read", {
    skillId,
    revision,
    selectedRevision: selected?.revision,
  });
  selected?.assertSessionAccess();
  const result = prepared.value;
  const files = await readSkillLibraryManifestTree(
    skillLibraryRevisionDir(skillId, result.entry.revision, access.options.env),
    result.manifestJson,
    result.entry.revision,
  );
  // Revocation or transfer during filesystem work must not return a private artifact.
  prepared.assertCurrent();
  selected?.assertSessionAccess();
  return {
    entry: result.entry,
    revisions: result.revisions,
    content: decodeSkillLibraryFile(files.find((file) => file.path === "SKILL.md")!).toString(
      "utf8",
    ),
    files: files.filter((file) => file.path !== "SKILL.md"),
  };
}

export async function saveSkillLibrary(
  authority: SkillLibraryAuthority,
  params: SkillsLibrarySaveParams,
  options: OpenClawStateDatabaseOptions = {},
  uploadId?: string,
): Promise<SkillsLibraryReceipt> {
  if (!validateSkillsLibrarySaveParams(params)) {
    throw new SkillLibraryError("INVALID_BUNDLE", "Invalid skill save parameters.");
  }
  const access = captureSkillLibraryAccess(authority, options);
  await access.read("profile", undefined);
  const previous = params.skillId
    ? (await access.read("entry", { skillId: params.skillId, write: true })).value
    : undefined;
  if (params.skillId && !previous) {
    throw new SkillLibraryError("NOT_FOUND", "Skill not found.");
  }
  if (previous) {
    assertSkillLibraryRevision(previous, params.expectedRevision);
  } else if (params.expectedRevision !== null) {
    throw new SkillLibraryError("CONFLICT", "A new skill requires expectedRevision: null.");
  }
  const bundle = prepareSkillLibraryBundle([
    { path: "SKILL.md", content: params.content },
    ...(params.files ?? []),
  ]);
  const skillId = params.skillId ?? uploadId ?? randomUUID();
  const scan = scanProposalBundle(
    params.content,
    bundle.files
      .filter((file) => file.path !== "SKILL.md")
      .map((file) => ({
        path: file.path,
        content: file.bytes.toString("utf8"),
        sizeBytes: file.sizeBytes,
        hash: file.sha256,
      })),
  );
  assertProposalContainsNoLiteralSecrets(scan);
  if (scan.critical > 0) {
    throw new SkillLibraryError(
      "POLICY_BLOCKED",
      "Skill security scan found critical issues. Review the instructions and support files before publishing.",
    );
  }
  const staged = await stageSkillLibraryBundle(
    skillId,
    bundle,
    access.options.env,
    authority.assertFileMutationAllowed,
  );
  try {
    const policy = await evaluateSkillInstallPolicy({
      config: authority.getConfig(),
      installId: "library",
      logger: {},
      origin: { type: "skill-library" },
      source: { kind: "local-path", authority: "user", mutable: false, network: false },
      skillName: params.slug,
      sourceDir: staged.staging,
      mode: previous ? "update" : "install",
    });
    if (policy?.blocked) {
      throw new SkillLibraryError("POLICY_BLOCKED", policy.blocked.reason);
    }
    access.assertCurrent();
    await staged.publish();
    return await access.write("skillLibrary.publish", {
      params: {
        skillId: params.skillId,
        slug: params.slug,
        expectedRevision: params.expectedRevision,
      },
      skillId,
      uploadId,
      bundle: {
        revision: bundle.revision,
        description: bundle.description,
        filesJson: JSON.stringify(bundle.files.map(({ bytes: _bytes, ...file }) => file)),
      },
    });
  } finally {
    await staged.cleanup();
  }
}

export async function mutateSkillLibrary(
  authority: SkillLibraryAuthority,
  params: SkillsLibraryMutateParams,
  options: OpenClawStateDatabaseOptions = {},
): Promise<SkillsLibraryReceipt> {
  return captureSkillLibraryAccess(authority, options).write("skillLibrary.mutate", { params });
}
