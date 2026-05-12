import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  MIGRATION_SKILL_SELECTION_SKIP,
  MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF,
  MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON,
} from "./selection.js";
import { promptMigrationSkillSelectionValues } from "./skill-selection-prompt.js";

function createPromptOutput(): NodeJS.WriteStream {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  Object.defineProperty(output, "columns", {
    configurable: true,
    value: 100,
  });
  return output as NodeJS.WriteStream;
}

async function runPromptWithReturn(params: {
  cursorAt: string;
  initialValues?: string[];
}): Promise<string[] | symbol | undefined> {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const result = promptMigrationSkillSelectionValues({
    message: "Select Codex skills",
    options: [
      { value: MIGRATION_SKILL_SELECTION_SKIP, label: "Skip for now" },
      { value: MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON, label: "Toggle all on" },
      { value: MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF, label: "Toggle all off" },
      { value: "skill:alpha", label: "alpha" },
      { value: "skill:beta", label: "beta" },
    ],
    initialValues: params.initialValues,
    required: false,
    cursorAt: params.cursorAt,
    selectableValues: ["skill:alpha", "skill:beta"],
    input,
    output: createPromptOutput(),
    withGuide: false,
  });
  setTimeout(() => input.write("\r"), 0);
  return await result;
}

describe("promptMigrationSkillSelectionValues", () => {
  it("activates Skip for now before submitting with return", async () => {
    await expect(
      runPromptWithReturn({
        cursorAt: MIGRATION_SKILL_SELECTION_SKIP,
        initialValues: ["skill:alpha", "skill:beta"],
      }),
    ).resolves.toEqual([MIGRATION_SKILL_SELECTION_SKIP]);
  });

  it("keeps the cursor item selected when submitting with return", async () => {
    await expect(
      runPromptWithReturn({
        cursorAt: "skill:alpha",
        initialValues: ["skill:alpha"],
      }),
    ).resolves.toEqual(["skill:alpha"]);
  });

  it("activates Toggle all off before submitting with return", async () => {
    await expect(
      runPromptWithReturn({
        cursorAt: MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF,
        initialValues: ["skill:alpha", "skill:beta"],
      }),
    ).resolves.toEqual([MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF]);
  });

  it("activates Toggle all on before submitting with return", async () => {
    await expect(
      runPromptWithReturn({
        cursorAt: MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON,
        initialValues: [],
      }),
    ).resolves.toEqual([MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON, "skill:alpha", "skill:beta"]);
  });
});
