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
type OfficialChannelInstall = NonNullable<
  NonNullable<OfficialChannelCatalogEntry["openclaw"]>["install"]
>;

function makeRepoRoot(prefix: string): string {
  return makeTempRepoRoot(tempDirs, prefix);
}

function writeJson(filePath: string, value: unknown): void {
  writeJsonFile(filePath, value);
}

function writeChannelPackage(
  repoRoot: string,
  directory: string,
  channel: OfficialChannelCatalogEntry["openclaw"]["channel"],
  options: {
    install?: OfficialChannelInstall;
    publishToNpm?: boolean;
    version?: string;
    description?: string;
  } = {},
): void {
  const { install, publishToNpm, ...packageFields } = options;
  writeJson(path.join(repoRoot, "extensions", directory, "package.json"), {
    name: `@openclaw/${directory}`,
    ...packageFields,
    openclaw: {
      channel: { id: directory, ...channel },
      ...(install ? { install } : {}),
      ...(publishToNpm === undefined ? {} : { release: { publishToNpm } }),
    },
  });
}

function requireInstall(entry: OfficialChannelCatalogEntry | undefined): OfficialChannelInstall {
  const install = entry?.openclaw?.install;
  if (!install) {
    throw new Error("expected official channel install config");
  }
  return install;
}

function requireNpmInstallSource(source: ReturnType<typeof describePluginInstallSource>) {
  if (!source.npm) {
    throw new Error("expected npm install source");
  }
  return source.npm;
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("buildOfficialChannelCatalog", () => {
  it("keeps third-party official external catalog install sources pinned", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-catalog-policy-");
    const entries = buildOfficialChannelCatalog({ repoRoot }).entries.filter(
      (entry) => entry.source === "external" && !entry.name?.startsWith("@openclaw/"),
    );

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const install = requireInstall(entry);
      const installSource = describePluginInstallSource(install);
      expect(installSource.warnings).toStrictEqual([]);
      if (install.npmSpec) {
        expect(requireNpmInstallSource(installSource).pinState).toBe("exact-with-integrity");
      } else {
        expect(installSource.npm).toBeUndefined();
        expect(installSource.clawhub?.exactVersion).toBe(true);
        expect(normalizeClawHubSha256Integrity(install.expectedIntegrity ?? "")).not.toBeNull();
      }
    }
  });

  it("allows official OpenClaw channel npm specs without integrity during launch", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-catalog-openclaw-policy-");
    writeChannelPackage(
      repoRoot,
      "twitch",
      { label: "Twitch", docsPath: "/channels/twitch" },
      {
        install: {
          npmSpec: "@openclaw/twitch",
          defaultChoice: "npm",
          minHostVersion: ">=2026.4.10",
        },
        publishToNpm: true,
      },
    );
    const twitch = buildOfficialChannelCatalog({ repoRoot }).entries.find(
      (entry) => entry.openclaw?.channel?.id === "twitch",
    );

    expect({
      name: twitch?.name,
      install: twitch?.openclaw?.install,
    }).toEqual({
      name: "@openclaw/twitch",
      install: {
        npmSpec: "@openclaw/twitch",
        defaultChoice: "npm",
        minHostVersion: ">=2026.4.10",
      },
    });
    const installSource = describePluginInstallSource(requireInstall(twitch));
    expect(requireNpmInstallSource(installSource).pinState).toBe("floating-without-integrity");
    expect(installSource.warnings).toEqual(["npm-spec-floating", "npm-spec-missing-integrity"]);
  });

  it("preserves ClawHub specs when generating publishable channel catalog entries", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-catalog-clawhub-");
    writeChannelPackage(
      repoRoot,
      "storepack-chat",
      {
        label: "Storepack Chat",
        selectionLabel: "Storepack Chat",
        docsPath: "/channels/storepack-chat",
        blurb: "storepack-first channel",
      },
      {
        install: {
          clawhubSpec: "clawhub:@openclaw/storepack-chat",
          npmSpec: "@openclaw/storepack-chat",
          defaultChoice: "clawhub",
        },
        publishToNpm: true,
      },
    );

    const entry = buildOfficialChannelCatalog({ repoRoot }).entries.find(
      (candidate) => candidate.openclaw?.channel?.id === "storepack-chat",
    );

    expect(requireInstall(entry)).toEqual({
      clawhubSpec: "clawhub:@openclaw/storepack-chat",
      npmSpec: "@openclaw/storepack-chat",
      defaultChoice: "clawhub",
    });
  });
});
