// Static tool-schema descriptors for skill_workshop, split from the runtime
// execution path so schema/action assertions never pay runtime import cost.
import { Type } from "typebox";
import { SKILL_AUTHORING_STANDARDS_PROMPT } from "../../skills/workshop/skill-authoring-standards.js";
import { stringEnum } from "../schema/typebox.js";

const SKILL_WORKSHOP_ACTIONS = [
  "list",
  "view",
  "create",
  "patch",
  "write_file",
  "remove_file",
  "archive",
  "restore",
  "draft",
  "discard",
] as const;

export const SkillWorkshopToolSchema = Type.Object(
  {
    action: stringEnum(SKILL_WORKSHOP_ACTIONS),
    name: Type.Optional(Type.String({ description: "Skill name (lowercase-hyphenated)." })),
    file_path: Type.Optional(
      Type.String({
        description:
          "SKILL.md (default) or a file under references/, templates/, scripts/, assets/.",
      }),
    ),
    content: Type.Optional(
      Type.String({ description: "create: full SKILL.md. write_file: full file content." }),
    ),
    old_text: Type.Optional(Type.String({ description: "patch: exact text to replace once." })),
    new_text: Type.Optional(Type.String({ description: "patch: replacement text." })),
    absorbed_into: Type.Optional(
      Type.String({ description: "archive: live skill that now covers this one." }),
    ),
    reason: Type.Optional(
      Type.String({
        description: "One short line saying what changed and why; shown to the user.",
      }),
    ),
    draft: Type.Optional(
      Type.String({ description: "view/discard: draft id from list (instead of name)." }),
    ),
    version: Type.Optional(
      Type.String({ description: "view/restore: version id; restore defaults to the newest." }),
    ),
  },
  { additionalProperties: false },
);

export const SKILL_WORKSHOP_DESCRIPTION = `Your learned skills: reusable procedures saved as <name>/SKILL.md that load in future sessions. Changes apply immediately, are versioned, and are shown to the user.
Actions: list | view name [file_path] [version] | create name content | patch name old_text new_text [file_path] | write_file name file_path content | remove_file name file_path | archive name (absorbed_into or reason) | restore name [version] | draft name content | view draft [file_path] | discard draft.
- create: content is the full SKILL.md: frontmatter name (= name) and description (aim for ≤160 bytes, triggers first), then the procedure.
- patch: replaces one exact, unique old_text; view first and copy the text exactly. Prefer patch over rewrites.
- file_path: SKILL.md or files under references/, templates/, scripts/, assets/. remove_file deletes one of those support files; archive removes a whole skill.
- reason: one short line saying what changed; shown to the user.
- restore without version undoes the last change.
- draft: saves a proposed SKILL.md for the user to review later; skills stay unchanged. list shows waiting drafts. When reviewing drafts with the user, save approved changes with create/patch, then discard the drafts the user decided on.

${SKILL_AUTHORING_STANDARDS_PROMPT}`;
