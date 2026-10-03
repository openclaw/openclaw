import path from "node:path";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
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
