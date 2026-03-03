import { describe, expect, it } from "vitest";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { noteSlackTokenHelp } from "./slack.js";

type NoteRecord = { message: string; title?: string };

function createBasePrompter(note: WizardPrompter["note"]): WizardPrompter {
  return {
    intro: async () => {},
    outro: async () => {},
    note,
    select: async <T>() => "" as T,
    multiselect: async <T>() => [] as T[],
    text: async () => "",
    confirm: async () => true,
    progress: () => ({
      update: () => {},
      stop: () => {},
    }),
  };
}

describe("noteSlackTokenHelp", () => {
  it("emits manifest through codeBlock when prompter supports raw blocks", async () => {
    const notes: NoteRecord[] = [];
    const blocks: Array<{ code: string; language?: string; title?: string }> = [];
    const prompter = createBasePrompter(async (message, title) => {
      notes.push({ message, title });
    });
    prompter.codeBlock = async (params) => {
      blocks.push(params);
    };

    await noteSlackTokenHelp(prompter, "Ops Bot");

    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toContain("use the JSON block shown after this note");
    expect(notes[0]?.message).not.toContain('"display_information"');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.title).toBe("Manifest (JSON)");
    expect(blocks[0]?.language).toBe("json");
    const parsed = JSON.parse(blocks[0]?.code ?? "{}") as {
      display_information?: { name?: string };
      features?: { slash_commands?: Array<{ command?: string }> };
    };
    expect(parsed.display_information?.name).toBe("Ops Bot");
    expect(parsed.features?.slash_commands?.[0]?.command).toBe("/openclaw");
  });

  it("falls back to note-only output when codeBlock is unavailable", async () => {
    const notes: NoteRecord[] = [];
    const prompter = createBasePrompter(async (message, title) => {
      notes.push({ message, title });
    });

    await noteSlackTokenHelp(prompter, "OpenClaw");

    expect(notes).toHaveLength(2);
    expect(notes[1]?.message.startsWith("Manifest (JSON):\n")).toBe(true);
    const manifest = notes[1]?.message.replace("Manifest (JSON):\n", "") ?? "";
    const parsed = JSON.parse(manifest) as {
      display_information?: { name?: string };
    };
    expect(parsed.display_information?.name).toBe("OpenClaw");
  });
});
