import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
const asset = (ref: string, mimeType: string, content: string | Buffer) => ({
  ref,
  mimeType,
  content: Buffer.from(content).toString("base64"),
});
const errors = (refs: string[], error: string) => refs.map((ref) => ({ ref, error }));
const repositoryAsset = (filePath: string, content: string | Buffer): SessionFileEntry => ({
  path: filePath,
  name: path.basename(filePath),
  kind: "read",
  missing: false,
  contentEncoding: typeof content === "string" ? "utf8" : "base64",
  content: typeof content === "string" ? content : content.toString("base64"),
});
function workspace(files: Record<string, string> = { "index.html": "" }) {
  const root = tempDirs.make("openclaw-session-assets-");
  for (const [file, content] of Object.entries(files)) {
    writeWorkspaceFile(root, file, content);
  }
  return root;
}
type ReadOptions = Partial<Parameters<typeof getSessionWorkspaceAssets>[0]>;
async function read(root: string, refs: string[], options: ReadOptions = {}) {
  return (await getSessionWorkspaceAssets({ root, path: "index.html", refs, ...options })).assets;
}

it("reads sibling images, stylesheets, and scripts from the returned document path", async () => {
  const root = workspace({
    "preview/index.html": "<img src='a.png'>",
    "preview/theme.css": "body { color: red; }",
    "preview/app.mjs": "globalThis.ready = true;",
  });
  fs.writeFileSync(path.join(root, "preview/a café.png"), png);
  expect(
    await read(root, ["a%20caf%C3%A9.png?cache=1#image", "theme.css", "app.mjs"], {
      fileRoot: path.join(root, "different-cwd"),
      path: "preview/index.html",
    }),
  ).toEqual([
    asset("a%20caf%C3%A9.png?cache=1#image", "image/png", png),
    asset("theme.css", "text/css", "body { color: red; }"),
    asset("app.mjs", "text/javascript", "globalThis.ready = true;"),
  ]);
});

it("requires host authority for each escaping asset and hides existence when denied", async () => {
  const parent = workspace({ "workspace/index.html": "", "private.css": "body {}" });
  const root = path.join(parent, "workspace");
  const refs = ["../private.css", "../missing.css"];
  expect(await read(root, refs)).toEqual(errors(refs, "outside_session_boundary"));
  const authorizeHostRead = vi.fn(async () => true);
  expect(await read(root, refs, { authorizeHostRead })).toEqual([
    asset("../private.css", "text/css", "body {}"),
    { ref: "../missing.css", error: "not_found" },
  ]);
  expect(authorizeHostRead).toHaveBeenCalledTimes(2);
});

it("keeps repository assets with their reader and rejects paths outside the repository", async () => {
  const root = workspace({ "preview/missing.js": "host content must stay private" });
  const repositoryFiles: SessionFileEntry[] = [
    repositoryAsset("preview/theme.css", "body {}"),
    repositoryAsset("assets/a.png", png),
  ];
  const repositoryFile = vi.fn(async (filePath: string) =>
    repositoryFiles.find((file) => file.path === filePath),
  );
  expect(
    await read(root, ["theme.css", "../assets/a.png", "../../outside.css", "missing.js"], {
      path: "preview/index.html",
      repositoryFile,
    }),
  ).toEqual([
    asset("theme.css", "text/css", "body {}"),
    asset("../assets/a.png", "image/png", png),
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
  const root = workspace({ "index.html": "", "font.woff2": "wOF2" });
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
  expect(
    await read(root, [...unsupported, "missing.png", "link.css", "hardlink.css", "."]),
  ).toEqual([
    ...errors(unsupported, "unsupported"),
    ...errors(["missing.png", "link.css", "hardlink.css", "."], "not_found"),
  ]);
});

it("enforces per-asset and aggregate byte limits before base64 encoding", async () => {
  const root = workspace({
    "index.html": "",
    "exact.css": " ".repeat(1024 * 1024),
    "oversized.css": " ".repeat(1024 * 1024 + 1),
  });
  const assets = await read(root, [
    "oversized.css",
    ...[1, 2, 3, 4, 5].map((n) => `exact.css?${n}`),
  ]);
  expect(assets[0]).toEqual({ ref: "oversized.css", error: "too_large" });
  for (const current of assets.slice(1, 5)) {
    expect(current).toHaveProperty("mimeType", "text/css");
    expect("content" in current && Buffer.from(current.content, "base64").length).toBe(1024 * 1024);
  }
  expect(assets[5]).toEqual({ ref: "exact.css?5", error: "too_large" });
});

it("revalidates read admission after awaited host authorization", async () => {
  const root = tempDirs.make("openclaw-session-assets-");
  const authorization = createDeferred<boolean>();
  let current = true;
  const pending = read(root, ["../private.css"], {
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
