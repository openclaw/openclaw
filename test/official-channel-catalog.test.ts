import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildOfficialChannelCatalog } from "../scripts/write-official-channel-catalog.mts";
import { normalizeClawHubSha256Integrity } from "../src/infra/clawhub-integrity.js";
import { describePluginInstallSource } from "../src/plugins/install-source-info.js";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "./helpers/temp-dir.js";
import { writeJsonFile } from "./helpers/temp-repo.js";

const tempDirs: string[] = [];

type OfficialChannelCatalogEntry = ReturnType<
  typeof buildOfficialChannelCatalog
>["entries"][number];
type OfficialChannelInstall = OfficialChannelCatalogEntry["openclaw"]["install"];

function writeChannelPackage(
  repoRoot: string,
  directory: string,
  channel: OfficialChannelCatalogEntry["openclaw"]["channel"],
  install: OfficialChannelInstall,
) {
  writeJsonFile(path.join(repoRoot, "extensions", directory, "package.json"), {
    name: `@openclaw/${directory}`,
    openclaw: {
      channel: { id: directory, ...channel },
      install,
      release: { publishToNpm: true },
    },
  });
  return buildOfficialChannelCatalog({ repoRoot }).entries.find(
    (entry) => entry.openclaw.channel.id === directory,
  );
}

function requireInstall(entry: OfficialChannelCatalogEntry | undefined): OfficialChannelInstall {
  const install = entry?.openclaw?.install;
  if (!install) {
    throw new Error("expected official channel install config");
  }
  return install;
}

afterEach(() => cleanupTempDirs(tempDirs));

describe("buildOfficialChannelCatalog", () => {
  it("keeps third-party official external catalog install sources pinned", () => {
    const repoRoot = makeTempRepoRoot(tempDirs, "openclaw-official-channel-catalog-policy-");
    const entries = buildOfficialChannelCatalog({ repoRoot }).entries.filter(
      (entry) => entry.source === "external" && !entry.name?.startsWith("@openclaw/"),
    );

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const install = requireInstall(entry);
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
    const repoRoot = makeTempRepoRoot(tempDirs, "openclaw-official-policy-");
    const twitch = writeChannelPackage(
      repoRoot,
      "twitch",
      { label: "Twitch", docsPath: "/channels/twitch" },
      {
        npmSpec: "@openclaw/twitch",
        defaultChoice: "npm",
        minHostVersion: ">=2026.4.10",
      },
    );

    expect(twitch?.name).toBe("@openclaw/twitch");
    expect(twitch?.openclaw.install).toEqual({
      npmSpec: "@openclaw/twitch",
      defaultChoice: "npm",
      minHostVersion: ">=2026.4.10",
    });
    const installSource = describePluginInstallSource(requireInstall(twitch));
    expect(installSource.npm?.pinState).toBe("floating-without-integrity");
    expect(installSource.warnings).toEqual(["npm-spec-floating", "npm-spec-missing-integrity"]);
  });

  it("preserves ClawHub specs when generating publishable channel catalog entries", () => {
    const repoRoot = makeTempRepoRoot(tempDirs, "openclaw-official-channel-catalog-clawhub-");
    const entry = writeChannelPackage(
      repoRoot,
      "storepack-chat",
      {
        label: "Storepack Chat",
        selectionLabel: "Storepack Chat",
        docsPath: "/channels/storepack-chat",
        blurb: "storepack-first channel",
      },
      {
        clawhubSpec: "clawhub:@openclaw/storepack-chat",
        npmSpec: "@openclaw/storepack-chat",
        defaultChoice: "clawhub",
      },
    );

    expect(requireInstall(entry)).toEqual({
      clawhubSpec: "clawhub:@openclaw/storepack-chat",
      npmSpec: "@openclaw/storepack-chat",
      defaultChoice: "clawhub",
    });
  });
});
