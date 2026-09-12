import { describe, expect, it } from "vitest";
import { availableFileActions, isSafeFileReference } from "./file-reference.ts";

describe("file reference safety", () => {
  it("accepts safe relative paths and rejects traversal/absolute paths", () => {
    const isSafe = (relativePath: string) =>
      isSafeFileReference({
        origin: "workspace",
        sessionKey: "session-1",
        name: "guide.md",
        relativePath,
      });
    expect(isSafe("docs\\guide.md")).toBe(true);
    expect(isSafe("./docs/guide.md")).toBe(true);
    for (const path of [
      "../secrets.txt",
      "C:\\secrets.txt",
      "\\\\server\\share\\file.txt",
      "/etc/passwd",
      "docs/../secret",
      "bad\0name",
      "",
    ]) {
      expect(isSafe(path)).toBe(false);
    }
  });

  it.each(["C:secret.txt", "c:secret.txt", "D:relative/file.txt", "Z:"])(
    "rejects drive-relative references and all their actions: %s",
    (relativePath) => {
      const reference = {
        origin: "workspace" as const,
        sessionKey: "session-1",
        name: "secret.txt",
        relativePath,
      };
      expect(isSafeFileReference(reference)).toBe(false);
      expect(availableFileActions(reference, { localGateway: true, hasContents: true })).toEqual(
        [],
      );
    },
  );

  it("requires an id for artifacts and a session key for session/workspace files", () => {
    expect(isSafeFileReference({ origin: "artifact", name: "a.txt" })).toBe(false);
    expect(
      isSafeFileReference({ origin: "artifact", artifactId: "artifact-1", name: "a.txt" }),
    ).toBe(true);
    expect(isSafeFileReference({ origin: "session", name: "a.txt", relativePath: "a.txt" })).toBe(
      false,
    );
    expect(isSafeFileReference({ origin: "workspace", name: "a.txt", relativePath: "a.txt" })).toBe(
      false,
    );
  });

  it("does not expose host filesystem actions to remote or artifact references", () => {
    const artifact = { origin: "artifact" as const, artifactId: "a", name: "a.bin" };
    expect(availableFileActions(artifact, { localGateway: true })).not.toContain(
      "revealInFileManager",
    );
    const workspace = {
      origin: "workspace" as const,
      sessionKey: "session-1",
      relativePath: "a.txt",
      name: "a.txt",
    };
    expect(availableFileActions(workspace, { localGateway: false })).not.toContain("copyFullPath");
    expect(availableFileActions(workspace, { localGateway: true })).toContain("openWorkspaceRoot");
  });

  it("offers no actions for invalid references", () => {
    expect(
      availableFileActions(
        { origin: "workspace", sessionKey: "session-1", name: "secret", relativePath: "../secret" },
        { localGateway: true, hasContents: true },
      ),
    ).toEqual([]);
    expect(availableFileActions({ origin: "artifact", name: "missing-id" })).toEqual([]);
  });
});
