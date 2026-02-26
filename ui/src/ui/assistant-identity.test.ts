import { describe, expect, it } from "vitest";
import { resolveDocumentTitle } from "./assistant-identity.ts";

describe("resolveDocumentTitle", () => {
  it("prefixes with agent name when it differs from default", () => {
    expect(resolveDocumentTitle("Sales Bot")).toBe("Sales Bot \u2014 OpenClaw Control");
  });

  it("returns base title for the default assistant name", () => {
    expect(resolveDocumentTitle("Assistant")).toBe("OpenClaw Control");
  });

  it("returns base title for empty string", () => {
    expect(resolveDocumentTitle("")).toBe("OpenClaw Control");
  });
});
