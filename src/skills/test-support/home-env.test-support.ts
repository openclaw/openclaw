// Home environment test support isolates HOME-style paths for skill tests.
import os from "node:os";
import { vi } from "vitest";
<<<<<<< HEAD
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

/** Process home env snapshot used by skill loader tests. */
export type SkillsHomeEnvSnapshot = {
  previousHome: string | undefined;
  previousOpenClawHome: string | undefined;
  previousUserProfile: string | undefined;
};

export function setMockSkillsHomeEnv(fakeHome: string): SkillsHomeEnvSnapshot {
  const snapshot: SkillsHomeEnvSnapshot = {
    previousHome: process.env.HOME,
    previousOpenClawHome: process.env.OPENCLAW_HOME,
    previousUserProfile: process.env.USERPROFILE,
  };
<<<<<<< HEAD
  setTestEnvValue("HOME", fakeHome);
  deleteTestEnvValue("OPENCLAW_HOME");
  deleteTestEnvValue("USERPROFILE");
=======
  process.env.HOME = fakeHome;
  delete process.env.OPENCLAW_HOME;
  delete process.env.USERPROFILE;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
  return snapshot;
}

<<<<<<< HEAD
function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    deleteTestEnvValue(key);
  } else {
    setTestEnvValue(key, value);
  }
}

=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export async function restoreMockSkillsHomeEnv(
  snapshot: SkillsHomeEnvSnapshot,
  cleanup?: () => Promise<void> | void,
) {
  vi.restoreAllMocks();
<<<<<<< HEAD
  restoreEnvValue("HOME", snapshot.previousHome);
  restoreEnvValue("OPENCLAW_HOME", snapshot.previousOpenClawHome);
  restoreEnvValue("USERPROFILE", snapshot.previousUserProfile);
=======
  if (snapshot.previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = snapshot.previousHome;
  }
  if (snapshot.previousOpenClawHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = snapshot.previousOpenClawHome;
  }
  if (snapshot.previousUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = snapshot.previousUserProfile;
  }
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  await cleanup?.();
}
