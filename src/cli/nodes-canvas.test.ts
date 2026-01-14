import { describe, expect, it } from "vitest";

import { parseCanvasSnapshotPayload } from "./nodes-canvas.js";

describe("nodes canvas helpers", () => {
  it("parses canvas.snapshot payload", () => {
    expect(parseCanvasSnapshotPayload({ format: "png", base64: "aGk=" })).toEqual({
      format: "png",
      base64: "aGk=",
    });
  });

  it("rejects invalid canvas.snapshot payload", () => {
    expect(() => parseCanvasSnapshotPayload({ format: "png" })).toThrow(
      /invalid canvas\.snapshot payload/i,
    );
  });
});
