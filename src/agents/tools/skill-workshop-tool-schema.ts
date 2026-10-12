// Static tool-schema descriptors for skill_workshop, split from the runtime
// execution path so schema/action assertions never pay runtime import cost.
import { Type } from "typebox";
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
    version: Type.Optional(
      Type.String({ description: "view/restore: version id; restore defaults to the newest." }),
    ),
  },
  { additionalProperties: false },
);
