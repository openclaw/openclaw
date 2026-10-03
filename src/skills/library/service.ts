import { randomUUID } from "node:crypto";
import {
  validateSkillsLibrarySaveParams,
  type SkillLibraryEntry,
  type SkillsLibraryListParams,
  type SkillsLibraryListResult,
  type SkillsLibrarySaveParams,
  type SkillsLibraryMutateParams,
  type SkillsLibraryReceipt,
  type SkillsLibraryReadResult,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { evaluateSkillInstallPolicy } from "../../plugins/install-security-scan.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
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
import {
  assertSkillLibraryNameAvailable,
  assertSkillLibraryRevision,
  ensureSkillLibrarySchema,
  readSkillLibraryStore,
  recordSkillLibraryEvent,
  requireSkillLibraryEntry,
  requireSkillLibraryProfile,
  requireSkillLibraryUploadMetadata,
  resolveSkillLibraryActor,
  selectSkillLibraryRevisionMetadata,
  skillLibraryDb,
  type SkillLibraryAuthority,
} from "./store.js";
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

export function skillLibraryReceipt(
  entry: SkillLibraryEntry,
  state: SkillsLibraryReceipt["state"] = "published",
): SkillsLibraryReceipt {
  return {
    state,
    target: entry.ownerProfileId === null ? "team" : "personal",
    entry,
    sessionActivation: "new-sessions",
    nextAction:
      state === "removed"
        ? "Existing sessions retain their pinned revision. Create a new skill to add it to future sessions."
        : !entry.enabled
          ? "Disabled for new-session defaults. Existing sessions retain their selected revision; explicit attachment remains available."
          : entry.ownerProfileId !== null && !entry.shared
            ? "Enabled for your new sessions, subject to agent policy and prerequisites. Existing session pins remain. Use skills.library.activate to attach or refresh it."
            : "Enabled for new team sessions, subject to agent policy and prerequisites. Existing session pins remain. Use skills.library.activate to attach or refresh it.",
  };
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
  requireSkillLibraryProfile(openOpenClawStateDatabase(options).db, authority);
  const previous = params.skillId
    ? readSkillLibraryStore(
        (db) => requireSkillLibraryEntry(db, params.skillId!, authority, true),
        options,
      )
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
    options.env,
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
    authority.assertCurrent();
    await staged.publish();
    ensureSkillLibrarySchema(options);
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const actor = requireSkillLibraryProfile(db, authority);
        if (uploadId) {
          const upload = requireSkillLibraryUploadMetadata(db, uploadId, authority);
          if (upload.slug !== params.slug) {
            throw new SkillLibraryError(
              "NOT_FOUND",
              "Upload slug changed; start the import again.",
            );
          }
          if (upload.published_skill_id) {
            return skillLibraryReceipt(
              requireSkillLibraryEntry(db, upload.published_skill_id, authority),
              "unchanged",
            );
          }
        }
        const current = params.skillId
          ? requireSkillLibraryEntry(db, skillId, authority, true)
          : undefined;
        if (current) {
          assertSkillLibraryRevision(current, params.expectedRevision);
        }
        const owner = current ? current.ownerProfileId : actor;
        assertSkillLibraryNameAvailable(db, owner, params.slug, skillId);
        if (current?.revision === bundle.revision && current.slug === params.slug) {
          return skillLibraryReceipt(current, "unchanged");
        }
        const now = Date.now();
        const kysely = skillLibraryDb(db);
        executeSqliteQuerySync(
          db,
          kysely
            .insertInto("skill_library_revisions")
            .values({
              skill_id: skillId,
              revision: bundle.revision,
              description: bundle.description,
              files_json: JSON.stringify(bundle.files.map(({ bytes: _bytes, ...file }) => file)),
              created_at: now,
            })
            .onConflict((conflict) => conflict.columns(["skill_id", "revision"]).doNothing()),
        );
        if (current) {
          executeSqliteQuerySync(
            db,
            kysely
              .updateTable("skill_library_entries")
              .set({ slug: params.slug, current_revision: bundle.revision, updated_at: now })
              .where("skill_id", "=", skillId),
          );
        } else {
          executeSqliteQuerySync(
            db,
            kysely.insertInto("skill_library_entries").values({
              skill_id: skillId,
              owner_profile_id: actor,
              author_profile_id: actor,
              slug: params.slug,
              current_revision: bundle.revision,
              shared: 0,
              enabled: 1,
              removed: 0,
              created_at: now,
              updated_at: now,
            }),
          );
        }
        recordSkillLibraryEvent(db, skillId, bundle.revision, current ? "save" : "create", actor);
        if (uploadId) {
          executeSqliteQuerySync(
            db,
            kysely
              .updateTable("skill_library_uploads")
              .set({ published_skill_id: skillId })
              .where("upload_id", "=", uploadId),
          );
        }
        return skillLibraryReceipt(requireSkillLibraryEntry(db, skillId, authority));
      },
      options,
      { operationLabel: "skills.library.publish" },
    );
  } finally {
    await staged.cleanup();
  }
}

export function mutateSkillLibrary(
  authority: SkillLibraryAuthority,
  params: SkillsLibraryMutateParams,
  options: OpenClawStateDatabaseOptions = {},
): SkillsLibraryReceipt {
  const exists = readSkillLibraryStore(
    (db) => requireSkillLibraryEntry(db, params.skillId, authority, true),
    options,
  );
  if (!exists) {
    throw new SkillLibraryError("NOT_FOUND", "Skill not found.");
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const actor = requireSkillLibraryProfile(db, authority);
      const current = requireSkillLibraryEntry(db, params.skillId, authority, true);
      assertSkillLibraryRevision(current, params.expectedRevision);
      const changes: {
        shared?: number;
        owner_profile_id?: null;
        enabled?: number;
        removed?: number;
        current_revision?: string;
      } = {};
      switch (params.action) {
        case "share":
        case "unshare":
          if (params.action === "unshare" && current.ownerProfileId === null) {
            throw new SkillLibraryError(
              "FORBIDDEN",
              "Team-owned skills cannot become personal through unshare.",
            );
          }
          changes.shared = Number(params.action === "share");
          break;
        case "transfer":
          if (!resolveSkillLibraryActor(db, authority).admin) {
            throw new SkillLibraryError(
              "FORBIDDEN",
              "Transfer to team ownership requires a Gateway administrator.",
            );
          }
          assertSkillLibraryNameAvailable(db, null, current.slug, current.skillId);
          changes.owner_profile_id = null;
          changes.shared = 1;
          break;
        case "enable":
        case "disable":
          changes.enabled = Number(params.action === "enable");
          break;
        case "remove":
          changes.removed = 1;
          break;
        case "rollback":
          if (
            !params.revision ||
            !selectSkillLibraryRevisionMetadata(db, current.skillId, params.revision)
          ) {
            throw new SkillLibraryError(
              "NOT_FOUND",
              "Choose a published revision from this skill's history.",
            );
          }
          changes.current_revision = params.revision;
          break;
      }
      executeSqliteQuerySync(
        db,
        skillLibraryDb(db)
          .updateTable("skill_library_entries")
          .set({ ...changes, updated_at: Date.now() })
          .where("skill_id", "=", current.skillId),
      );
      recordSkillLibraryEvent(
        db,
        current.skillId,
        changes.current_revision ?? current.revision,
        params.action,
        actor,
      );
      return skillLibraryReceipt(
        requireSkillLibraryEntry(db, current.skillId, authority),
        params.action === "remove" ? "removed" : "published",
      );
    },
    options,
    { operationLabel: "skills.library.mutate" },
  );
}
