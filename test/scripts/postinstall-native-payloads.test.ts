import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { pruneNonHostNativePayloads } from "../../scripts/postinstall-bundled-plugins.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "native-payload-test-"));
  roots.push(root);
  const modules = path.join(root, "node_modules");
  const put = (name: string, data: Record<string, unknown>) => {
    const dir = path.join(modules, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, ...data }));
    return dir;
  };
  put("esbuild", {
    optionalDependencies: { "@esbuild/linux-x64": "1", "@esbuild/darwin-arm64": "1" },
  });
  return { root, modules, put };
}
it("removes only explicitly incompatible optional payloads and preserves the native binary", () => {
  const { root, put } = fixture();
  const other = put("@esbuild/linux-x64", { os: ["linux"], cpu: ["x64"] });
  const native = put("@esbuild/darwin-arm64", { os: ["darwin"], cpu: ["arm64"] });
  const undeclared = put("@esbuild/linux-arm64", { os: ["linux"] });
  expect(pruneNonHostNativePayloads(root, "darwin", "arm64")).toEqual(["@esbuild/linux-x64"]);
  expect(existsSync(other)).toBe(false);
  expect(existsSync(native)).toBe(true);
  expect(existsSync(undeclared)).toBe(true);
  expect(pruneNonHostNativePayloads(root, "darwin", "arm64")).toEqual([]);
});
it("preserves unknown and negative constraints", () => {
  const { root, put } = fixture();
  put("@esbuild/linux-x64", { os: ["!darwin"] });
  put("@esbuild/darwin-arm64", {});
  expect(pruneNonHostNativePayloads(root, "darwin", "arm64")).toEqual([]);
});
it("does not follow a payload symlink outside the installed package", () => {
  const { root, modules, put } = fixture();
  const outside = put("@esbuild/elsewhere", { name: "@esbuild/linux-x64", os: ["linux"] });
  symlinkSync(outside, path.join(modules, "@esbuild/linux-x64"));
  expect(pruneNonHostNativePayloads(root, "darwin", "arm64")).toEqual([]);
  expect(existsSync(outside)).toBe(true);
});
