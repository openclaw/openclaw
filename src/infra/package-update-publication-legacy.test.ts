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

it.skipIf(process.platform === "win32").each(["previous", "candidate"] as const)(
  "uses the legacy %s verification policy",
  async (selected) => {
    const root = dirs.make("publication-legacy-");
    await writePackageRoot(root, "2026.9.8");
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules/.package-lock.json"), "{}");
    fs.symlinkSync("package.json", path.join(root, "manifest-link"));
    fs.linkSync(path.join(root, "package.json"), path.join(root, "manifest-hardlink"));
    const fingerprint = legacyPackageFingerprint(root);
    const warning = vi.fn();
    const matcher = createPackagePublicationTreeMatcher(
      {
        previous: selected === "previous" ? fingerprint : { ...fingerprint },
        candidate: selected === "candidate" ? fingerprint : { ...fingerprint },
        helperDigest,
      },
      warning,
    );

    await expect(matcher.matches(root, fingerprint, root)).resolves.toBe(true);
    expect(warning.mock.calls).toEqual(
      selected === "previous"
        ? [
            [
              "legacy package record settled by identity and version; content could not be re-verified",
            ],
          ]
        : [],
    );
  },
);

it.skipIf(process.platform === "win32").each(["previous", "candidate", "current"] as const)(
  "limits link-count fallback to the legacy previous generation: %s",
  async (selected) => {
    const parent = dirs.make("publication-ctime-");
    const root = path.join(parent, "package");
    await writePackageRoot(root, "2026.9.8");
    const legacyFingerprint = legacyPackageFingerprint(root);
    const fingerprint =
      selected === "current" ? await createPackageIntegrityReader().tree(root) : legacyFingerprint;
    const warning = vi.fn();
    const matcher = createPackagePublicationTreeMatcher(
      {
        previous: selected === "candidate" ? { ...fingerprint } : fingerprint,
        candidate: selected === "candidate" ? fingerprint : { ...fingerprint },
        helperDigest: selected === "current" ? "0".repeat(64) : helperDigest,
      },
      warning,
    );
    const file = path.join(root, "package.json");
    const before = fs.statSync(file, { bigint: true });
    const link = path.join(parent, "temporary-hardlink");
    fs.linkSync(file, link);
    expect(fs.statSync(file, { bigint: true }).nlink).toBe(before.nlink + 1n);
    expect(legacyPackageFingerprint(root).digest).not.toBe(legacyFingerprint.digest);

    if (selected === "candidate") {
      await expect(matcher.matches(root, fingerprint, root)).rejects.toThrow(
        "Package publication object changed",
      );
      expect(warning).not.toHaveBeenCalled();
    } else {
      await expect(matcher.matches(root, fingerprint, root)).resolves.toBe(true);
      expect(warning.mock.calls).toEqual(
        selected === "previous"
          ? [
              [
                "legacy package record settled by identity and version; content could not be re-verified",
              ],
            ]
          : [],
      );
    }
  },
);

it.skipIf(process.platform === "win32").each(["version", "root", "current content"])(
  "refuses a changed %s without a legacy identity/version match",
  async (changed) => {
    const parent = dirs.make("publication-refusal-");
    const root = path.join(parent, "package");
    await writePackageRoot(root, "2026.9.8");
    const previous =
      changed === "current content"
        ? await createPackageIntegrityReader().tree(root)
        : legacyPackageFingerprint(root);
    const warning = vi.fn();
    const matcher = createPackagePublicationTreeMatcher(
      {
        previous,
        candidate: { ...previous },
        helperDigest: changed === "current content" ? "0".repeat(64) : helperDigest,
      },
      warning,
    );
    if (changed === "root") {
      fs.renameSync(root, path.join(parent, "retained"));
      await writePackageRoot(root, "2026.9.8");
    } else if (changed === "current content") {
      fs.writeFileSync(path.join(root, "dist/index.js"), "changed package content\n");
    } else {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.9" }));
    }
    await expect(matcher.matches(root, previous, root)).rejects.toThrow(
      "Package publication object changed",
    );
    expect(warning).not.toHaveBeenCalled();
  },
);
