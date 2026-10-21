import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, expect } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { uploadSkillLibrary } from "./import.js";
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
    return { options, alice: actor(alice.id), admin: actor(alice.id, true), actor, stateDir };
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
