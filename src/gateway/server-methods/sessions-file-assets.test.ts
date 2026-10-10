import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionFileEntry } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getSessionWorkspaceAssets } from "./sessions-file-assets.js";
import { writeWorkspaceFile } from "./sessions-files.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);

describe("session HTML asset reads", () => {
  it("reads sibling images, stylesheets, and scripts from the returned document path", async () => {
    const root = tempDirs.make("openclaw-session-assets-");
    writeWorkspaceFile(root, "preview/index.html", "<img src='a.png'>");
    writeWorkspaceFile(root, "preview/theme.css", "body { color: red; }");
    writeWorkspaceFile(root, "preview/app.mjs", "globalThis.ready = true;");
    fs.writeFileSync(path.join(root, "preview/a café.png"), png);
    const result = await getSessionWorkspaceAssets({
      root,
      fileRoot: path.join(root, "different-cwd"),
      path: "preview/index.html",
      refs: ["a%20caf%C3%A9.png?cache=1#image", "theme.css", "app.mjs"],
    });
    expect(result.assets).toEqual([
      {
        ref: "a%20caf%C3%A9.png?cache=1#image",
        mimeType: "image/png",
        content: png.toString("base64"),
      },
      {
        ref: "theme.css",
        mimeType: "text/css",
        content: Buffer.from("body { color: red; }").toString("base64"),
      },
      {
        ref: "app.mjs",
        mimeType: "text/javascript",
        content: Buffer.from("globalThis.ready = true;").toString("base64"),
      },
    ]);
  });

  it("requires host authority for each escaping asset and hides existence when denied", async () => {
    const parent = tempDirs.make("openclaw-session-assets-");
    const root = path.join(parent, "workspace");
    writeWorkspaceFile(root, "index.html", "");
    writeWorkspaceFile(parent, "private.css", "body {}");
    const refs = ["../private.css", "../missing.css"];
    expect((await getSessionWorkspaceAssets({ root, path: "index.html", refs })).assets).toEqual(
      refs.map((ref) => ({ ref, error: "outside_session_boundary" })),
    );
    const authorizeHostRead = vi.fn(async () => true);
    expect(
      (await getSessionWorkspaceAssets({ root, path: "index.html", refs, authorizeHostRead }))
        .assets,
    ).toEqual([
      {
        ref: "../private.css",
        mimeType: "text/css",
        content: Buffer.from("body {}").toString("base64"),
      },
      { ref: "../missing.css", error: "not_found" },
    ]);
    expect(authorizeHostRead).toHaveBeenCalledTimes(2);
  });

  it("keeps repository assets with their reader and rejects paths outside the repository", async () => {
    const root = tempDirs.make("openclaw-session-assets-");
    writeWorkspaceFile(root, "preview/missing.js", "host content must stay private");
    const repositoryFiles: SessionFileEntry[] = [
      {
        path: "preview/theme.css",
        name: "theme.css",
        kind: "read",
        missing: false,
        contentEncoding: "utf8",
        content: "body {}",
      },
      {
        path: "assets/a.png",
        name: "a.png",
        kind: "read",
        missing: false,
        contentEncoding: "base64",
        content: png.toString("base64"),
      },
    ];
    const repositoryFile = vi.fn(async (filePath: string) =>
      repositoryFiles.find((file) => file.path === filePath),
    );
    const result = await getSessionWorkspaceAssets({
      root,
      path: "preview/index.html",
      refs: ["theme.css", "../assets/a.png", "../../outside.css", "missing.js"],
      repositoryFile,
    });
    expect(result.assets).toEqual([
      {
        ref: "theme.css",
        mimeType: "text/css",
        content: Buffer.from("body {}").toString("base64"),
      },
      { ref: "../assets/a.png", mimeType: "image/png", content: png.toString("base64") },
      { ref: "../../outside.css", error: "outside_session_boundary" },
      { ref: "missing.js", error: "not_found" },
    ]);
    expect(repositoryFile.mock.calls).toEqual([
      ["preview/theme.css"],
      ["assets/a.png"],
      ["preview/missing.js"],
    ]);
  });

  it("reports invalid URLs, unavailable files, fonts, and non-UTF-8 scripts per reference", async () => {
    const root = tempDirs.make("openclaw-session-assets-");
    writeWorkspaceFile(root, "index.html", "");
    writeWorkspaceFile(root, "font.woff2", "wOF2");
    fs.writeFileSync(path.join(root, "broken.js"), Buffer.from([0xff]));
    fs.symlinkSync("index.html", path.join(root, "link.css"));
    fs.linkSync(path.join(root, "index.html"), path.join(root, "hardlink.css"));
    const unsupported = [
      "https://example.com/a.png",
      "//example.com/a.png",
      "#id",
      "data:image/png;base64,AA==",
      "/a.png",
      "~/a.png",
      "%2Fa.png",
      "%00.png",
      "%zz",
      "font.woff2",
      "broken.js",
    ];
    const result = await getSessionWorkspaceAssets({
      root,
      path: "index.html",
      refs: [...unsupported, "missing.png", "link.css", "hardlink.css", "."],
    });
    expect(result.assets).toEqual([
      ...unsupported.map((ref) => ({ ref, error: "unsupported" })),
      ...["missing.png", "link.css", "hardlink.css", "."].map((ref) => ({
        ref,
        error: "not_found",
      })),
    ]);
  });

  it("enforces per-asset and aggregate byte limits before base64 encoding", async () => {
    const root = tempDirs.make("openclaw-session-assets-");
    writeWorkspaceFile(root, "index.html", "");
    writeWorkspaceFile(root, "exact.css", " ".repeat(1024 * 1024));
    writeWorkspaceFile(root, "oversized.css", " ".repeat(1024 * 1024 + 1));
    const result = await getSessionWorkspaceAssets({
      root,
      path: "index.html",
      refs: [
        "oversized.css",
        "exact.css?1",
        "exact.css?2",
        "exact.css?3",
        "exact.css?4",
        "exact.css?5",
      ],
    });
    expect(result.assets[0]).toEqual({ ref: "oversized.css", error: "too_large" });
    for (const asset of result.assets.slice(1, 5)) {
      expect(asset).toHaveProperty("mimeType", "text/css");
      expect("content" in asset && Buffer.from(asset.content, "base64").length).toBe(1024 * 1024);
    }
    expect(result.assets[5]).toEqual({ ref: "exact.css?5", error: "too_large" });
  });

  it("revalidates read admission after awaited host authorization", async () => {
    const root = tempDirs.make("openclaw-session-assets-");
    const authorization = createDeferred<boolean>();
    let current = true;
    const pending = getSessionWorkspaceAssets({
      root,
      path: "index.html",
      refs: ["../private.css"],
      authorizeHostRead: () => authorization.promise,
      assertCurrent: () => {
        if (!current) {
          throw new Error("session access revoked");
        }
      },
    });
    current = false;
    authorization.resolve(true);
    await expect(pending).rejects.toThrow("session access revoked");
  });
});
