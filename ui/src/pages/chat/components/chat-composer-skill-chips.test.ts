import { afterEach, expect, it } from "vitest";
import { buildFallbackSlashCommands, replaceSlashCommands } from "../../../lib/chat/commands.ts";
import { resolveComposerSkillChips } from "./chat-composer-skill-chips.ts";

afterEach(() => replaceSlashCommands(buildFallbackSlashCommands()));

it("projects known tokens at UTF-16 offsets without swallowing punctuation or unknown text", () => {
  replaceSlashCommands([
    {
      key: "skill",
      name: "prose_writer",
      description: "Write prose",
      source: "skill",
      skillDisplayName: "Prose Writer",
      skillModelVisible: true,
    },
  ]);
  const value = "🧪 $prose_writer: next /unknown $prose_writer_extra /prose_writer.";
  const chips = resolveComposerSkillChips(value, { editing: false, caret: value.length });
  expect(
    chips.map(({ start, end, label }) => ({ text: value.slice(start, end), start, label })),
  ).toEqual([
    { text: "$prose_writer", start: 3, label: "Prose Writer" },
    { text: "/prose_writer", start: value.lastIndexOf("/prose_writer"), label: "Prose Writer" },
  ]);
});

it("keeps a complete query editable until confirmation and reprojects current catalog labels", () => {
  replaceSlashCommands([
    {
      key: "skill",
      name: "prose_writer",
      description: "Write prose",
      source: "skill",
      skillModelVisible: true,
    },
  ]);
  const value = "/prose_writer";
  expect(resolveComposerSkillChips(value, { editing: true, caret: value.length })).toEqual([]);
  expect(resolveComposerSkillChips(value, { editing: false, caret: value.length })[0]?.label).toBe(
    "prose writer",
  );
  replaceSlashCommands(buildFallbackSlashCommands());
  expect(resolveComposerSkillChips(value, { editing: false, caret: value.length })).toEqual([]);
});
