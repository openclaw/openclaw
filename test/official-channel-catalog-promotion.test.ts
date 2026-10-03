import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildOfficialChannelCatalog } from "../scripts/write-official-channel-catalog.mts";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["preserve-root", true, false, undefined])(
  "publishes only the static root-preservation contract (configPromotion=%s)",
  (configPromotion) => {
    const repoRoot = tempDirs.make("openclaw-promotion-catalog-");
    const pluginDir = path.join(repoRoot, "extensions", "synthetic-chat");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/synthetic-chat",
        version: "1.0.0",
        openclaw: {
          channel: { id: "synthetic-chat" },
          setupFeatures: { configPromotion, legacySessionSurfaces: true },
          release: { publishToNpm: true },
        },
      }),
    );
    const entry = buildOfficialChannelCatalog({ repoRoot }).entries.find(
      (candidate) => candidate.name === "@openclaw/synthetic-chat",
    );
    expect(entry?.openclaw.setupFeatures).toEqual(
      configPromotion === "preserve-root" ? { configPromotion: "preserve-root" } : undefined,
    );
  },
);
