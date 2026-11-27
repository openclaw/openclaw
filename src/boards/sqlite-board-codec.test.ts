import { describe, expect, it } from "vitest";
import { parseManifest } from "./sqlite-board-codec.js";

describe("board widget manifest codec", () => {
  it.each(["html", "mcp-app", "plugin"])("preserves %s content ownership", (contentOwner) => {
    expect(parseManifest(JSON.stringify({ contentOwner }))).toMatchObject({ contentOwner });
  });

  it("rejects unknown explicit widget ownership", () => {
    expect(() => parseManifest('{"contentOwner":"unknown"}')).toThrow(/content ownership/i);
  });

  it("ignores invalid persisted frame preferences", () => {
    expect(
      parseManifest(JSON.stringify({ presentation: "floating", heightMode: "elastic" })),
    ).toEqual({});
  });

  it("flags invalid persisted generated name identity metadata", () => {
    expect(
      parseManifest(
        JSON.stringify({
          nameIdentity: { kind: "generated", source: "show_widget", key: "short" },
        }),
      ),
    ).toEqual({ nameIdentityInvalid: true });
  });
});
