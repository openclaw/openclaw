import type { TranslationMap } from "../lib/types.ts";
import { registerSessionSkillLibraryEnglish } from "./en-session-skill-library.ts";
import { en } from "./en.ts";

// Editor copy stays with the lazy Skills surface; sessions load only their subset.
const enSkillLibrary = {
  skillGroups: {
    workspace: "Workspace Skills",
    learned: "Learned Skills",
    builtIn: "Built-in Skills",
    installed: "Installed Skills",
    extra: "Extra Skills",
    other: "Other Skills",
  },
  skillStatus: {
    bundled: "bundled",
    eligible: "eligible",
    blocked: "blocked",
    disabled: "disabled",
    blockedAllowlist: "blocked by allowlist",
    blockedAgentFilter: "blocked by agent filter",
  },
  skillDiscovery: {
    search: "Search skills",
    settings: "Skill settings",
    libraryStatus: "Library skill. Session selections control when it is used.",
  },
  skillLibrary: {
    library: "Skill library",
    mine: "My skills",
    team: "Team",
    all: "All libraries",
    inventory: registerSessionSkillLibraryEnglish.catalog.skillLibrary.inventory,
    create: "Create skill",
    import: "Import skill",
    save: "Save skill",
    slug: "Skill name",
    slugHelp: "Use 1–63 lowercase letters, digits, or hyphens; start with a letter or digit.",
    file: registerSessionSkillLibraryEnglish.catalog.skillLibrary.file,
    newFile: "New text file path",
    addFile: "Add file",
    deleteFile: "Delete file",
    deleteFileConfirm: "Remove {path} from the next saved bundle?",
    fileExists: "That file already exists. Select it to edit its contents.",
    binary: "Binary attachment. Its original bytes are preserved when you save.",
    binaryRead: registerSessionSkillLibraryEnglish.catalog.skillLibrary.binaryRead,
    readOnly: "You can read this skill. Only its owner or an authorized administrator can edit it.",
    personalTarget:
      "My skills. Save to your personal library; existing session selections change only when you explicitly attach or refresh.",
    technicalDetails: registerSessionSkillLibraryEnglish.catalog.skillLibrary.technicalDetails,
    skillId: registerSessionSkillLibraryEnglish.catalog.skillLibrary.skillId,
    command: registerSessionSkillLibraryEnglish.catalog.skillLibrary.command,
    ownerRevision: registerSessionSkillLibraryEnglish.catalog.skillLibrary.ownerRevision,
    executable: "Executable supporting file",
    defaultLimit: registerSessionSkillLibraryEnglish.catalog.skillLibrary.defaultLimit,
    session: registerSessionSkillLibraryEnglish.catalog.skillLibrary.session,
    search: "Search names, descriptions, and owners",
    empty: "No skills in this library. Create one or import a bundle.",
    you: "You",
    shared: "Shared with team",
    private: "Private",
    share: "Share with team",
    unshare: "Make private",
    transfer: "Transfer to team",
    remove: "Remove skill",
    enable: "Enable",
    disable: "Disable",
    revision: registerSessionSkillLibraryEnglish.catalog.skillLibrary.revision,
    selectRevision: "Select a revision",
    rollback: "Restore revision",
    discard: "Discard your unsaved skill changes?",
    conflict:
      "This skill changed since you opened it. Your draft is preserved. Copy your changes, then close and reopen the skill to review the current revision before saving.",
    signIn: "Sign in with a Gateway profile to create personal skills.",
    connectionChanged: "The Gateway connection changed. Reopen the skill before saving.",
    bundleLimit: "Use at most 256 files, 1 MiB per file, and 8 MiB per bundle or ZIP.",
    missingSkill:
      "Choose SKILL.md together with its supporting files, or a folder containing SKILL.md at its root.",
    uploadFailed:
      "The Gateway did not confirm the upload. Check your library before retrying the import.",
    importHelp: "Import a skill into your private library.",
    importClawHub: "Import {source} into your private library.",
    files: "Files",
    filesHelp: "SKILL.md with supporting files, a folder, or a ZIP (saved on import).",
    chooseFilesButton: "Choose files",
    chooseFolderButton: "Choose folder",
    noFilesSelected: "No files selected.",
    selectedFile: "{count} file · {names}",
    selectedFiles: "{count} files · {names}",
    clearSelection: "Clear",
    confirm: {
      remove: "Remove {slug} from the library?",
      transfer: "Transfer {slug} to team ownership? Team administrators will manage it.",
    },
    receipt: {
      published: "Saved {slug} to {target} library (owner: {owner}).",
      unchanged: "Unchanged: {slug} in {target} library (owner: {owner}).",
      removed: "Removed {slug} from {target} library (owner: {owner}).",
    },
  },
} satisfies TranslationMap;

export const registerSkillLibraryEnglish = Object.assign(
  () => {
    Object.assign((en.skillLibrary ??= enSkillLibrary.skillLibrary), enSkillLibrary.skillLibrary);
    en.skillDiscovery = enSkillLibrary.skillDiscovery;
    Object.assign(en.skillGroups, enSkillLibrary.skillGroups);
    Object.assign(en.skillStatus, enSkillLibrary.skillStatus);
  },
  { catalog: enSkillLibrary },
);
