import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultLocalRoots } from "../../plugin-sdk/web-media.js";
import { resolveMediaToolLocalRoots } from "./media-tool-shared.js";

describe("resolveMediaToolLocalRoots", () => {
  it("expands tilde allowedRoots when workspaceOnly is true", () => {
    const result = resolveMediaToolLocalRoots("/workspace", {
      workspaceOnly: true,
      allowedRoots: ["~/projects/media"],
    });

    expect(result).toEqual(
      expect.arrayContaining(["/workspace", path.join(os.homedir(), "projects/media")]),
    );
  });

  it("normalizes @-prefixed allowedRoots when workspaceOnly is true", () => {
    const result = resolveMediaToolLocalRoots("/workspace", {
      workspaceOnly: true,
      allowedRoots: ["@/shared/media"],
    });

    expect(result).toEqual(expect.arrayContaining(["/workspace", "/shared/media"]));
    expect(result).not.toContain(path.resolve("@/shared/media"));
  });

  it("preserves default media roots when workspaceOnly is true", () => {
    const result = resolveMediaToolLocalRoots("/workspace", {
      workspaceOnly: true,
      allowedRoots: ["/shared/media"],
    });

    expect(result).toEqual(expect.arrayContaining(getDefaultLocalRoots() as string[]));
    expect(result).toEqual(expect.arrayContaining(["/workspace", "/shared/media"]));
  });

  it("rejects relative allowedRoots when workspaceOnly is true", () => {
    expect(() =>
      resolveMediaToolLocalRoots("/workspace", {
        workspaceOnly: true,
        allowedRoots: ["relative/media"],
      }),
    ).toThrow(/allowedRoots entries must be absolute paths/i);
  });

  it("ignores allowedRoots when workspaceOnly is false", () => {
    const result = resolveMediaToolLocalRoots("/workspace", {
      workspaceOnly: false,
      allowedRoots: ["/shared/media"],
    });

    expect(result).toContain("/workspace");
    expect(result).not.toContain("/shared/media");
  });
});
