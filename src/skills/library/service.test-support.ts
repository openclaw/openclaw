import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, expect } from "vitest";
import {
  SKILL_LIBRARY_MAX_FILE_BYTES,
  type SkillLibrarySelection,
  type SkillsLibraryListParams,
  type SkillsLibraryMutateParams,
  type SkillsLibrarySaveParams,
  type SkillsLibraryActivateParams,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import type { SkillLibraryErrorCode } from "../skill-library-error.js";
import { uploadSkillLibrary } from "./import.js";
import { changeSkillLibrarySelection, seedSkillLibrarySelection } from "./selection.js";
import {
  listSkillLibrary,
  mutateSkillLibrary,
  readSkillLibrary,
  saveSkillLibrary,
} from "./service.js";
import type { SkillLibraryAuthority } from "./store.js";

export const content =
  "---\nname: guide\ndescription: A reusable test procedure\n---\n# Guide\nRead references/data.bin before running scripts/task.sh.\n";

export const draft = (slug = "guide") => ({
  slug,
  content,
  expectedRevision: null,
  files: [
    { path: "references/data.bin", content: "AP+A", encoding: "base64" as const },
    { path: "scripts/task.sh", content: "#!/bin/sh\nprintf ready", executable: true },
  ],
});

export async function expectCode(result: Promise<unknown>, code: SkillLibraryErrorCode) {
  await expect(result).rejects.toMatchObject({ code });
}

export function libraryPin({
  skillId,
  revision,
  name,
  ownerProfileId,
}: SkillLibrarySelection): SkillLibrarySelection {
  return { skillId, revision, name, ownerProfileId };
}

export function expectSingleWinner(
  results: PromiseSettledResult<unknown>[],
  code: SkillLibraryErrorCode,
) {
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code },
  });
}

export function useSkillLibraryFixture() {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  const fixture = () => {
    const stateDir = tempDirs.make("skill-library-");
    const options = {
      path: path.join(stateDir, "state", "openclaw.sqlite"),
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    };
    const alice = ensureProfileForEmail("alice@example.test", options);
    const actor = (profileId?: string, admin = false): SkillLibraryAuthority => ({
      profileId,
      scopes: admin ? ["operator.admin"] : ["operator.read", "operator.write"],
      getConfig: () => ({}),
      assertCurrent: () => {},
    });
    const owner = actor(alice.id);
    return {
      options,
      alice: owner,
      admin: actor(alice.id, true),
      actor,
      stateDir,
      lib: {
        save: (params: SkillsLibrarySaveParams = draft(), who = owner) =>
          saveSkillLibrary(who, params, options),
        revise: ({ skillId, revision }: { skillId: string; revision: string }, body: string) =>
          saveSkillLibrary(
            owner,
            { ...draft(), skillId, expectedRevision: revision, content: body },
            options,
          ),
        read: (id: string, who = owner, revision?: string) =>
          readSkillLibrary(who, id, revision, options),
        list: (who = owner, params: SkillsLibraryListParams = {}) =>
          listSkillLibrary(who, params, options),
        mutate: (params: SkillsLibraryMutateParams, who = owner) =>
          mutateSkillLibrary(who, params, options),
        change: (
          { skillId, revision }: { skillId: string; revision: string },
          action: SkillsLibraryMutateParams["action"],
          who = owner,
        ) => mutateSkillLibrary(who, { skillId, expectedRevision: revision, action }, options),
        seed: (who = owner) => seedSkillLibrarySelection(who, options),
        select: (
          pins: Parameters<typeof changeSkillLibrarySelection>[1],
          params: SkillsLibraryActivateParams,
          who = owner,
        ) => changeSkillLibrarySelection(who, pins, params, options),
        chunk: (uploadId: string, bytes: Buffer, who = owner) =>
          uploadSkillLibrary(
            who,
            { action: "chunk", uploadId, offset: 0, data: bytes.toString("base64") },
            options,
          ),
        commit: (uploadId: string, who = owner) =>
          uploadSkillLibrary(who, { action: "commit", uploadId }, options),
        begin: (bytes: Buffer, slug: string, who = owner) =>
          beginZipUpload(who, bytes, slug, options),
      },
    };
  };
  return { fixture, tempDirs };
}

export async function beginZipUpload(
  authority: SkillLibraryAuthority,
  bytes: Buffer,
  slug: string,
  options: NonNullable<Parameters<typeof uploadSkillLibrary>[2]>,
) {
  const begun = await uploadSkillLibrary(
    authority,
    {
      action: "begin",
      slug,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    options,
  );
  if (!("uploadId" in begun)) {
    throw new Error("Expected upload ID");
  }
  expect(begun.offset).toBe(0);
  return begun;
}

export async function zipBytes(oversized = false) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip().file(oversized ? "wrapped/SKILL.md" : "SKILL.md", content);
  if (oversized) {
    zip.file("wrapped/oversized.bin", Buffer.alloc(SKILL_LIBRARY_MAX_FILE_BYTES + 1, 97));
  }
  return zip.generateAsync({ type: "nodebuffer", compression: oversized ? "DEFLATE" : "STORE" });
}
