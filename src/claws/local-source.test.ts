import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveLocalClawSource } from "./local-source.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture(extension = "tgz") {
  const dir = tempDirs.make("openclaw-claw-local-source-");
  const root = join(dir, "source.tgz");
  await mkdir(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "@example/offline", version: "1.0.0", openclaw: { claw: "CLAW.md" } }),
  );
  await writeFile(
    join(root, "CLAW.md"),
    "---\nschemaVersion: 1\nagent:\n  id: offline\n---\nOffline instructions.\n",
  );
  const archive = join(dir, `delivery.${extension}`);
  await tar.c({ cwd: root, file: archive, gzip: true, prefix: "package" }, ["."]);
  return { root, archive };
}

describe("local Claw archive sources", () => {
  it.each(["corrupt", "manifest-only"])("rejects a %s archive", async (kind) => {
    const { root, archive } = await fixture();
    if (kind === "corrupt") {
      await writeFile(archive, "not a tarball");
    } else {
      await rm(join(root, "package.json"));
      await tar.c({ cwd: root, file: archive, gzip: true, prefix: "package" }, ["."]);
    }
    await using source = await resolveLocalClawSource(archive);
    expect(source.claw).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid_claw_archive" }],
    });
  });

  it.each(["tgz", "tar.gz"])(
    "reads a built-package %s and releases its extracted source",
    async (ext) => {
      const { archive } = await fixture(ext);
      let packageRoot: string;
      {
        await using source = await resolveLocalClawSource(archive);
        expect(source.claw.ok).toBe(true);
        if (!source.claw.ok) {
          throw new Error("Expected a valid packaged Claw");
        }
        expect(source.claw.source).toMatchObject({ kind: "package", name: "@example/offline" });
        expect(source.claw.clawMarkdownBody?.toString()).toContain("Offline instructions.");
        packageRoot = source.claw.source.packageRoot;
        expect(await readFile(join(packageRoot, "CLAW.md"), "utf8")).toContain(
          "Offline instructions.",
        );
      }
      await expect(stat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("preserves package directories even when their name ends in .tgz", async () => {
    const { root } = await fixture();
    {
      await using source = await resolveLocalClawSource(root);
      expect(source.claw.ok).toBe(true);
    }
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it("rejects a linked archive entry before returning a source", async () => {
    const { root, archive } = await fixture();
    const outside = join(root, "..", "operator-file");
    await writeFile(outside, "operator-owned");
    await symlink(outside, join(root, "escape"));
    await tar.c({ cwd: root, file: archive, gzip: true, prefix: "package" }, ["."]);
    await using source = await resolveLocalClawSource(archive);
    expect(source.claw).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid_claw_archive" }],
    });
    expect(await readFile(outside, "utf8")).toBe("operator-owned");
  });
});
