import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveOpenClawInstallationRevision } from "./openclaw-installation-id.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("OpenClaw installation revision", () => {
  it("changes for package activation, source revision, and same-HEAD rebuilds", () => {
    const root = tempDirs.make("openclaw-installation-revision-");
    fs.writeFileSync(path.join(root, "openclaw.mjs"), "");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "dist", "build-info.json"), '{"buildId":"build-1"}');
    fs.mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${"a".repeat(40)}\n`);

    const initial = resolveOpenClawInstallationRevision(root);
    expect(resolveOpenClawInstallationRevision(root)).toBe(initial);

    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2.0.0" }));
    const activated = resolveOpenClawInstallationRevision(root);
    expect(activated).not.toBe(initial);

    fs.writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${"b".repeat(40)}\n`);
    const nextCommit = resolveOpenClawInstallationRevision(root);
    expect(nextCommit).not.toBe(activated);

    fs.writeFileSync(path.join(root, "dist", "build-info.json"), '{"buildId":"build-2"}');
    expect(resolveOpenClawInstallationRevision(root)).not.toBe(nextCommit);
  });

  it("uses the runtime entry when optional build metadata is unavailable", () => {
    const root = tempDirs.make("openclaw-installation-entry-revision-");
    fs.writeFileSync(path.join(root, "openclaw.mjs"), "");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "dist", "entry.js"), "export const build = 1;");

    const initial = resolveOpenClawInstallationRevision(root);
    expect(initial).toBeDefined();

    fs.writeFileSync(path.join(root, "dist", "entry.js"), "export const build = 2;");
    expect(resolveOpenClawInstallationRevision(root)).not.toBe(initial);
  });
});
