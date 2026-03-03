import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { buildSlackManifest, noteSlackTokenHelp } from "./slack.js";

describe("noteSlackTokenHelp", () => {
  const writes: string[] = [];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writes.length = 0;
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      if (typeof chunk === "string") {
        writes.push(chunk);
      } else if (chunk instanceof Uint8Array) {
        writes.push(Buffer.from(chunk).toString("utf8"));
      } else {
        writes.push(String(chunk));
      }
      return true;
    }) as never);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("prints the Slack manifest as raw JSON instead of embedding it in note framing", async () => {
    const note = vi.fn(async () => {});
    const prompter = { note } as unknown as WizardPrompter;
    const manifest = buildSlackManifest("OpenClaw");

    await noteSlackTokenHelp(prompter, "OpenClaw");

    expect(note).toHaveBeenCalledTimes(1);
    const noteMessage = String(note.mock.calls[0]?.[0] ?? "");
    expect(noteMessage).toContain("Manifest (JSON) is printed raw below for copy/paste.");
    expect(noteMessage).not.toContain('"display_information"');
    expect(writes.join("")).toContain(manifest);
  });
});
