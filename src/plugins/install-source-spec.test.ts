import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveFileNpmSpecToLocalPath } from "./install-source-spec.js";

describe("resolveFileNpmSpecToLocalPath", () => {
  it.each(["plugin.tgz", "plugin ü 空 #%.tgz"])("decodes a local file URL for %s", (name) => {
    const localPath = path.resolve("fixtures", name);
    expect(resolveFileNpmSpecToLocalPath(pathToFileURL(localPath).href)).toEqual({
      ok: true,
      path: localPath,
    });
  });

  it("decodes localhost file URLs", () => {
    const localPath = path.resolve("fixtures", "plugin ü 空.tgz");
    const url = pathToFileURL(localPath);
    url.hostname = "localhost";
    expect(resolveFileNpmSpecToLocalPath(url.href)).toEqual({ ok: true, path: localPath });
  });

  it.each(["./plugin%20name.tgz", "../plugin.tgz", "C:\\plugins\\plugin.tgz", "~/plugin.tgz"])(
    "preserves path-style file specs: %s",
    (localPath) => {
      expect(resolveFileNpmSpecToLocalPath("file:" + localPath)).toEqual({
        ok: true,
        path: localPath,
      });
    },
  );

  it.each(["file:///bad%ZZ.tgz", "file:///bad%2Fname.tgz"])(
    "rejects malformed URL %s without throwing",
    (spec) => {
      expect(resolveFileNpmSpecToLocalPath(spec)).toEqual({ ok: false, error: expect.any(String) });
    },
  );

  it("continues rejecting remote URL hosts", () => {
    expect(resolveFileNpmSpecToLocalPath("file://server/share/plugin.tgz")).toEqual({
      ok: false,
      error: 'unsupported file: URL host (expected "file:<path>" or "file:///abs/path")',
    });
  });

  it("leaves non-file specs and missing-path errors unchanged", () => {
    expect(resolveFileNpmSpecToLocalPath("npm:plugin")).toBeNull();
    expect(resolveFileNpmSpecToLocalPath("file:")).toEqual({
      ok: false,
      error: "unsupported file: spec: missing path",
    });
  });
});
