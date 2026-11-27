import { expect, it, vi } from "vitest";
import { resolveFileNpmSpecToLocalPath } from "./install-source-spec.js";

vi.mock("node:url", async (importOriginal) => {
  const url = await importOriginal<typeof import("node:url")>();
  return {
    ...url,
    // Exercise Node's Windows conversion on every host, without a production test seam.
    fileURLToPath: (value: string | URL) => url.fileURLToPath(value, { windows: true }),
  };
});

it.each(["file:///C:/plugins/", "file://localhost/C:/plugins/"])(
  "decodes Windows plugin archive URLs through %s",
  (prefix) => {
    expect(resolveFileNpmSpecToLocalPath(`${prefix}demo%20%C3%BC%20%23%25.tgz`)).toEqual({
      ok: true,
      path: "C:\\plugins\\demo ü #%.tgz",
    });
  },
);

it.each(["./demo%20name.tgz", "../demo.tgz", "C:\\plugins\\demo.tgz", "~/demo.tgz"])(
  "preserves literal path-style file specs: %s",
  (path) => expect(resolveFileNpmSpecToLocalPath(`file:${path}`)).toEqual({ ok: true, path }),
);

it.each(["file:///C:/bad%ZZ.tgz", "file:///C:/bad%2Fname.tgz", "file://server/share/demo.tgz"])(
  "returns an install error for %s",
  (spec) => expect(resolveFileNpmSpecToLocalPath(spec)).toMatchObject({ ok: false }),
);
