import { afterEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { noteSlackTokenHelp } from "./slack.js";

type NoteRecord = { message: string; title?: string };
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

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
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalStdoutIsTTY) {
      Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });

  it("prints manifest as raw JSON on TTY for copy/paste", async () => {
    const notes: NoteRecord[] = [];
    const prompter = createBasePrompter(async (message, title) => {
      notes.push({ message, title });
    });
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    await noteSlackTokenHelp(prompter, "Ops Bot");

    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toContain("use the JSON block shown after this note");
    expect(notes[0]?.message).not.toContain('"display_information"');
    const writes = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    const parsed = JSON.parse(writes) as {
      display_information?: { name?: string };
      features?: { slash_commands?: Array<{ command?: string }> };
    };
    expect(parsed.display_information?.name).toBe("Ops Bot");
    expect(parsed.features?.slash_commands?.[0]?.command).toBe("/openclaw");
  });

  it("falls back to note output for non-TTY prompters", async () => {
    const notes: NoteRecord[] = [];
    const prompter = createBasePrompter(async (message, title) => {
      notes.push({ message, title });
    });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

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
