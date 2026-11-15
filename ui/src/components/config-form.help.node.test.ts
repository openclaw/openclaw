import { describe, expect, it } from "vitest";
import { summarizeConfigHelp } from "./config-form.help.ts";

describe("summarizeConfigHelp", () => {
  it("keeps short help whole with nothing on demand", () => {
    expect(summarizeConfigHelp("Network bind profile")).toEqual({
      summary: "Network bind profile",
      clipped: false,
    });
  });

  it("shows the first sentence and leaves the rest on demand", () => {
    expect(
      summarizeConfigHelp("Queue mode for active runs. Use steer to inject prompts into the run."),
    ).toEqual({ summary: "Queue mode for active runs.", clipped: true });
  });

  it("stops before a list of values", () => {
    expect(
      summarizeConfigHelp('Controls provider catalog behavior: "merge" keeps built-ins.').summary,
    ).toBe("Controls provider catalog behavior");
  });

  it("does not stop at abbreviations, quoted text or parentheses", () => {
    expect(
      summarizeConfigHelp('Targeted logs by flag (e.g. "a.b. c") and more. Second sentence.')
        .summary,
    ).toBe('Targeted logs by flag (e.g. "a.b. c") and more.');
  });

  it("moves a default note out of the sentence", () => {
    expect(summarizeConfigHelp("Fetch updates in the background (default: true).")).toEqual({
      summary: "Fetch updates in the background.",
      clipped: true,
    });
  });

  it("offers the full text when one sentence may not fit its line", () => {
    const sentence = `${"word ".repeat(12).trim()}.`;
    expect(summarizeConfigHelp(sentence, "beside").clipped).toBe(true);
    expect(summarizeConfigHelp(sentence, "full").clipped).toBe(false);
  });

  it("drops a sentence that only restates the label", () => {
    expect(summarizeConfigHelp("Primary model.", "beside", "Primary model")).toEqual({
      summary: "",
      clipped: false,
    });
  });

  it("keeps what a restated label leaves out on demand", () => {
    expect(
      summarizeConfigHelp("Primary model (provider/model).", "beside", "Primary model"),
    ).toEqual({ summary: "", clipped: true });
    expect(summarizeConfigHelp("Primary model. Used first.", "beside", "Primary model")).toEqual({
      summary: "",
      clipped: true,
    });
  });

  it("keeps a sentence that says more than the label", () => {
    expect(
      summarizeConfigHelp("Ordered fallback models (provider/model).", "beside", "Fallbacks")
        .summary,
    ).toBe("Ordered fallback models (provider/model).");
  });

  it("treats missing help as empty", () => {
    expect(summarizeConfigHelp(undefined)).toEqual({ summary: "", clipped: false });
  });
});
