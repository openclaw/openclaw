import type {
  SkillLibraryEntry,
  SkillsLibraryReceipt,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";

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
