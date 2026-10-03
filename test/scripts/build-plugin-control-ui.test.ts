import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("rebuilds browser assets without invalidating unchanged manifest inputs", () => {
  const rootDir = tempDirs.make("openclaw-control-ui-script-");
  fs.symlinkSync(path.resolve("node_modules"), path.join(rootDir, "node_modules"), "junction");
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({ name: "fixture", type: "module", openclaw: { controlUi: "browser.ts" } }),
  );
  const manifestPath = path.join(rootDir, "openclaw.plugin.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ id: "fixture" }));
  fs.writeFileSync(
    path.join(rootDir, "browser.ts"),
    'import "./browser.css"; export const label = "Fixture";\n',
  );
  fs.writeFileSync(path.join(rootDir, "browser.css"), ".fixture { color: red; }\n");
  const build = () =>
    execFileSync(
      process.execPath,
      [
        "--import",
        path.resolve("scripts/tsx.mjs"),
        path.resolve("scripts/build-plugin-control-ui.mts"),
        rootDir,
      ],
      { timeout: 10_000, stdio: "pipe" },
    );

  build();
  const publishedManifest = fs.readFileSync(manifestPath, "utf8");
  const { entry, styles } = JSON.parse(publishedManifest).controlUi;
  const compactManifest = JSON.stringify({
    id: "fixture",
    categories: ["channels"],
    controlUi: { styles, entry },
  });
  const assetPath = path.join(rootDir, entry);
  const asset = fs.readFileSync(assetPath, "utf8");
  // External runtime compilation clears dist after the asset phase snapshots
  // source identity. Rebuilding must restore assets without republishing that input.
  for (const manifest of [publishedManifest, compactManifest]) {
    fs.writeFileSync(manifestPath, manifest);
    const before = fs.statSync(manifestPath, { bigint: true });
    fs.rmSync(path.join(rootDir, "dist"), { recursive: true });
    build();

    expect(fs.readFileSync(assetPath, "utf8")).toBe(asset);
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(manifest);
    const after = fs.statSync(manifestPath, { bigint: true });
    expect({ ino: after.ino, ctimeNs: after.ctimeNs }).toEqual({
      ino: before.ino,
      ctimeNs: before.ctimeNs,
    });
  }

  // A no-op must retain the atomic writer's refusal of linked destinations.
  const linkedManifest = path.join(rootDir, "linked-manifest.json");
  fs.renameSync(manifestPath, linkedManifest);
  fs.symlinkSync(linkedManifest, manifestPath, "file");
  expect(build).toThrow("atomic replace destination must not be a symbolic link");
});
