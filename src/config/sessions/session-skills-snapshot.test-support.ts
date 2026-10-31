import type { SessionSkillSnapshot } from "./session-prompt-types.js";

export function createRetainedSkillsSnapshotFixture(): SessionSkillSnapshot {
  return {
    prompt: "",
    skills: [],
    librarySelections: [
      {
        skillId: "11111111-1111-4111-8111-111111111111",
        revision: "a".repeat(64),
        name: "notes",
        ownerProfileId: "snapshot-owner",
      },
    ],
  };
}
