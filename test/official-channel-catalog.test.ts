import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOfficialChannelCatalog,
  OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH,
  writeOfficialChannelCatalog,
} from "../scripts/write-official-channel-catalog.mjs";
import { bundledPluginRoot } from "./helpers/bundled-plugin-paths.js";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "./helpers/temp-repo.js";

const tempDirs: string[] = [];

function makeRepoRoot(prefix: string): string {
  return makeTempRepoRoot(tempDirs, prefix);
}

function writeJson(filePath: string, value: unknown): void {
  writeJsonFile(filePath, value);
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("buildOfficialChannelCatalog", () => {
  it("includes publishable official channel plugins and skips non-publishable entries", () => {
    const repoRoot = makeRepoRoot("mullusi-official-channel-catalog-");
    writeJson(path.join(repoRoot, "extensions", "whatsapp", "package.json"), {
      name: "@mullusi/whatsapp",
      version: "2026.3.23",
      description: "Mullusi WhatsApp channel plugin",
      mullusi: {
        channel: {
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp (QR link)",
          detailLabel: "WhatsApp Web",
          docsPath: "/channels/whatsapp",
          blurb: "works with your own number; recommend a separate phone + eSIM.",
        },
        install: {
          npmSpec: "@mullusi/whatsapp",
          localPath: bundledPluginRoot("whatsapp"),
          defaultChoice: "npm",
        },
        release: {
          publishToNpm: true,
        },
      },
    });
    writeJson(path.join(repoRoot, "extensions", "local-only", "package.json"), {
      name: "@mullusi/local-only",
      mullusi: {
        channel: {
          id: "local-only",
          label: "Local Only",
          selectionLabel: "Local Only",
          docsPath: "/channels/local-only",
          blurb: "dev only",
        },
        install: {
          localPath: bundledPluginRoot("local-only"),
        },
        release: {
          publishToNpm: false,
        },
      },
    });

    expect(buildOfficialChannelCatalog({ repoRoot })).toEqual({
      entries: [
        {
          name: "@mullusi/whatsapp",
          version: "2026.3.23",
          description: "Mullusi WhatsApp channel plugin",
          mullusi: {
            channel: {
              id: "whatsapp",
              label: "WhatsApp",
              selectionLabel: "WhatsApp (QR link)",
              detailLabel: "WhatsApp Web",
              docsPath: "/channels/whatsapp",
              blurb: "works with your own number; recommend a separate phone + eSIM.",
            },
            install: {
              npmSpec: "@mullusi/whatsapp",
              defaultChoice: "npm",
            },
          },
        },
      ],
    });
  });

  it("writes the official catalog under dist", () => {
    const repoRoot = makeRepoRoot("mullusi-official-channel-catalog-write-");
    writeJson(path.join(repoRoot, "extensions", "whatsapp", "package.json"), {
      name: "@mullusi/whatsapp",
      mullusi: {
        channel: {
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
          docsPath: "/channels/whatsapp",
          blurb: "wa",
        },
        install: {
          npmSpec: "@mullusi/whatsapp",
        },
        release: {
          publishToNpm: true,
        },
      },
    });

    writeOfficialChannelCatalog({ repoRoot });

    const outputPath = path.join(repoRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual({
      entries: [
        {
          name: "@mullusi/whatsapp",
          mullusi: {
            channel: {
              id: "whatsapp",
              label: "WhatsApp",
              selectionLabel: "WhatsApp",
              docsPath: "/channels/whatsapp",
              blurb: "wa",
            },
            install: {
              npmSpec: "@mullusi/whatsapp",
            },
          },
        },
      ],
    });
  });
});
