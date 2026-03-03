import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints manifest as raw JSON when prompter supports raw output", async () => {
    const notes: NoteRecord[] = [];
    const prompter = createBasePrompter(async (message, title) => {
      notes.push({ message, title });
    });
    const rawSpy = vi.fn(async () => {});
    prompter.raw = rawSpy;

    await noteSlackTokenHelp(prompter, "Ops Bot");

    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toContain("use the JSON block shown after this note");
    expect(notes[0]?.message).not.toContain('"display_information"');
    expect(rawSpy).toHaveBeenCalledTimes(1);
    const rawManifest = String(rawSpy.mock.calls[0]?.[0] ?? "");
    const parsed = JSON.parse(rawManifest) as {
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
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

    try {
      await noteSlackTokenHelp(prompter, "OpenClaw");
    } finally {
      if (ttyDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
      }
    }

    expect(writeSpy).not.toHaveBeenCalled();
    expect(notes).toHaveLength(2);
    expect(notes[1]?.message.startsWith("Manifest (JSON):\n")).toBe(true);
    const manifest = notes[1]?.message.replace("Manifest (JSON):\n", "") ?? "";
    const parsed = JSON.parse(manifest) as {
      display_information?: { name?: string };
    };
    expect(parsed.display_information?.name).toBe("OpenClaw");
  });
});
