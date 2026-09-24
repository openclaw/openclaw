import path from "node:path";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import type { SkillLibraryAuthority } from "./store.js";

export const content =
  "---\nname: guide\ndescription: A reusable test procedure\n---\n# Guide\nRead references/data.bin before running scripts/task.sh.\n";
export function createSkillLibraryFixture(stateDir: string) {
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
}
export const draft = (slug = "guide") => ({
  slug,
  content,
  expectedRevision: null,
  files: [
    { path: "references/data.bin", content: "AP+A", encoding: "base64" as const },
    { path: "scripts/task.sh", content: "#!/bin/sh\nprintf ready", executable: true },
  ],
});
