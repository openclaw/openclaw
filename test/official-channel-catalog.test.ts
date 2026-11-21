import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import { buildOfficialChannelCatalog } from "../scripts/write-official-channel-catalog.mts";
import { normalizeClawHubSha256Integrity } from "../src/infra/clawhub-integrity.js";
import { describePluginInstallSource } from "../src/plugins/install-source-info.js";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "./helpers/temp-dir.js";
import { writeJsonFile } from "./helpers/temp-repo.js";

const tempDirs: string[] = [];
let repoRoot: string;
beforeEach(() => {
  repoRoot = makeTempRepoRoot(tempDirs, "openclaw-channel-catalog-");
});

type OfficialChannelCatalogEntry = ReturnType<
  typeof buildOfficialChannelCatalog
>["entries"][number];
type OfficialChannelInstall = OfficialChannelCatalogEntry["openclaw"]["install"];

function writeChannelPackage(directory: string, install: OfficialChannelInstall) {
  writeJsonFile(path.join(repoRoot, "extensions", directory, "package.json"), {
    name: `@openclaw/${directory}`,
    openclaw: {
      channel: { id: directory },
      install,
      release: { publishToNpm: true },
    },
  });
  const entry = buildOfficialChannelCatalog({ repoRoot }).entries.find(
    (candidate) => candidate.openclaw.channel.id === directory,
  );
  assert(entry, "expected official channel catalog entry");
  return entry;
}

afterEach(() => cleanupTempDirs(tempDirs));

describe("buildOfficialChannelCatalog", () => {
  it("keeps third-party official external catalog install sources pinned", () => {
    const entries = buildOfficialChannelCatalog({ repoRoot }).entries.filter(
      (entry) => entry.source === "external" && !entry.name?.startsWith("@openclaw/"),
    );

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const install = entry.openclaw.install;
      const installSource = describePluginInstallSource(install);
      expect(installSource.warnings).toStrictEqual([]);
      if (install.npmSpec) {
        expect(installSource.npm?.pinState).toBe("exact-with-integrity");
      } else {
        expect(installSource.npm).toBeUndefined();
        expect(installSource.clawhub?.exactVersion).toBe(true);
        expect(normalizeClawHubSha256Integrity(install.expectedIntegrity ?? "")).not.toBeNull();
      }
    }
  });

  it("allows official OpenClaw channel npm specs without integrity during launch", () => {
    const twitch = writeChannelPackage("twitch", {
      npmSpec: "@openclaw/twitch",
      defaultChoice: "npm",
      minHostVersion: ">=2026.4.10",
    });

    expect(twitch?.name).toBe("@openclaw/twitch");
    expect(twitch?.openclaw.install).toEqual({
      npmSpec: "@openclaw/twitch",
      defaultChoice: "npm",
      minHostVersion: ">=2026.4.10",
    });
    expect(describePluginInstallSource(twitch.openclaw.install)).toMatchObject({
      npm: { pinState: "floating-without-integrity" },
      warnings: ["npm-spec-floating", "npm-spec-missing-integrity"],
    });
  });

  it("preserves ClawHub specs when generating publishable channel catalog entries", () => {
    const entry = writeChannelPackage("storepack-chat", {
      clawhubSpec: "clawhub:@openclaw/storepack-chat",
      npmSpec: "@openclaw/storepack-chat",
      defaultChoice: "clawhub",
    });

    expect(entry.openclaw.install).toEqual({
      clawhubSpec: "clawhub:@openclaw/storepack-chat",
      npmSpec: "@openclaw/storepack-chat",
      defaultChoice: "clawhub",
    });
  });
});
