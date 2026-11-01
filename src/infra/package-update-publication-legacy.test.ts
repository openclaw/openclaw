import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPackageIntegrityReader } from "./package-update-integrity.js";
import { legacyPackageFingerprint } from "./package-update-legacy.test-support.js";
import { createPackagePublicationTreeMatcher } from "./package-update-publication-tree.js";
import { writePackageRoot } from "./package-update-steps.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
// Published npm tarball helper, not a version inferred from the installed package.
const helperDigest = "e08dfc1fb3ba7962f9e01d7a6770117c6cd77406b3fa4f7ba94788a670030ba0";
const legacyWarning =
  "legacy package record settled by identity and version; content could not be re-verified";

async function fixture(selected = "previous", linked = false) {
  const parent = dirs.make("publication-legacy-");
  const root = path.join(parent, "package");
  await writePackageRoot(root, "2026.9.8");
  const file = path.join(root, "package.json");
  if (linked) {
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules/.package-lock.json"), "{}");
    fs.symlinkSync("package.json", path.join(root, "manifest-link"));
    fs.linkSync(file, path.join(root, "manifest-hardlink"));
  }
  const legacy = legacyPackageFingerprint(root);
  const current = selected === "current";
  const fingerprint = current ? await createPackageIntegrityReader().tree(root) : legacy;
  const warning = vi.fn();
  const matcher = createPackagePublicationTreeMatcher(
    {
      previous: selected === "candidate" ? { ...fingerprint } : fingerprint,
      candidate: selected === "candidate" ? fingerprint : { ...fingerprint },
      helperDigest: current ? "0".repeat(64) : helperDigest,
    },
    warning,
  );
  const matches = () => matcher.matches(root, fingerprint, root);
  return { root, parent, file, legacy, warning, matches };
}

it.skipIf(process.platform === "win32").each(["previous", "candidate"] as const)(
  "uses the legacy %s verification policy",
  async (selected) => {
    const { matches, warning } = await fixture(selected, true);
    await expect(matches()).resolves.toBe(true);
    expect(warning.mock.calls).toEqual(selected === "previous" ? [[legacyWarning]] : []);
  },
);

it.skipIf(process.platform === "win32").each(["previous", "candidate", "current"] as const)(
  "limits link-count fallback to the legacy previous generation: %s",
  async (selected) => {
    const { parent, root, file, legacy, matches, warning } = await fixture(selected);
    const before = fs.statSync(file, { bigint: true });
    fs.linkSync(file, path.join(parent, "temporary-hardlink"));
    expect(fs.statSync(file, { bigint: true }).nlink).toBe(before.nlink + 1n);
    expect(legacyPackageFingerprint(root).digest).not.toBe(legacy.digest);

    if (selected === "candidate") {
      await expect(matches()).rejects.toThrow("Package publication object changed");
      expect(warning).not.toHaveBeenCalled();
    } else {
      await expect(matches()).resolves.toBe(true);
      expect(warning.mock.calls).toEqual(
        selected === "previous"
          ? [[legacyWarning]]
          : [[expect.stringContaining("Repaired permissions on")]],
      );
    }
  },
);

it.skipIf(process.platform === "win32").each(["version", "root", "current content"])(
  "refuses a changed %s without a legacy identity/version match",
  async (changed) => {
    const { parent, root, file, matches, warning } = await fixture(
      changed === "current content" ? "current" : "previous",
    );
    if (changed === "root") {
      fs.renameSync(root, path.join(parent, "retained"));
      await writePackageRoot(root, "2026.9.8");
    } else if (changed === "current content") {
      fs.writeFileSync(path.join(root, "dist/index.js"), "changed package content\n");
    } else {
      fs.writeFileSync(file, JSON.stringify({ version: "2026.9.9" }));
    }
    await expect(matches()).rejects.toThrow("Package publication object changed");
    expect(warning).not.toHaveBeenCalled();
  },
);
