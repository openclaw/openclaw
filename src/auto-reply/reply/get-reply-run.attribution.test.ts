import { describe, expect, it } from "vitest";
import { resolveMessageAttribution } from "./get-reply-run.js";

describe("resolveMessageAttribution", () => {
  it("parses exact Attribution line", () => {
    expect(
      resolveMessageAttribution(
        "START INSTRUCTION\nAttribution: initiative=CTX-010 activity=dev\nEND INSTRUCTION",
      ),
    ).toEqual({
      initiative: "CTX-010",
      activity: "dev",
      source: "message_tag",
      schemaVersion: "v1",
    });
  });

  it("falls back to defaults when line is missing", () => {
    expect(resolveMessageAttribution("hello")).toEqual({
      initiative: "UNSCOPED",
      activity: "ops",
      source: "default",
      schemaVersion: "v1",
    });
  });

  it("falls back to defaults when activity is invalid", () => {
    expect(resolveMessageAttribution("Attribution: initiative=CTX-010 activity=design")).toEqual({
      initiative: "UNSCOPED",
      activity: "ops",
      source: "default",
      schemaVersion: "v1",
    });
  });
});
