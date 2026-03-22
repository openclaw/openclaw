import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAtLeast, parseSemver } from "../infra/runtime-guard.js";
import { parseMinHostVersionRequirement } from "./min-host-version.js";

const MIN_HOST_VERSION_BASELINE = "2026.3.22";
const PLUGIN_MANIFEST_PATHS_REQUIRING_MIN_HOST_VERSION = [
  "extensions/bluebubbles/package.json",
  "extensions/discord/package.json",
  "extensions/feishu/package.json",
  "extensions/googlechat/package.json",
  "extensions/irc/package.json",
  "extensions/line/package.json",
  "extensions/matrix/package.json",
  "extensions/mattermost/package.json",
  "extensions/memory-lancedb/package.json",
  "extensions/msteams/package.json",
  "extensions/nextcloud-talk/package.json",
  "extensions/nostr/package.json",
  "extensions/synology-chat/package.json",
  "extensions/tlon/package.json",
  "extensions/twitch/package.json",
  "extensions/voice-call/package.json",
  "extensions/whatsapp/package.json",
  "extensions/zalo/package.json",
  "extensions/zalouser/package.json",
] as const;

type PackageJsonLike = {
  openclaw?: {
    install?: {
      minHostVersion?: string;
    };
  };
};

describe("install minHostVersion guardrails", () => {
  it("requires published plugins that depend on new sdk subpaths to declare a host floor", () => {
    const baseline = parseSemver(MIN_HOST_VERSION_BASELINE);
    expect(baseline).not.toBeNull();
    if (!baseline) {
      return;
    }

    for (const relativePath of PLUGIN_MANIFEST_PATHS_REQUIRING_MIN_HOST_VERSION) {
      const manifest = JSON.parse(
        fs.readFileSync(path.resolve(relativePath), "utf-8"),
      ) as PackageJsonLike;
      const requirement = parseMinHostVersionRequirement(
        manifest.openclaw?.install?.minHostVersion,
      );

      expect(
        requirement,
        `${relativePath} should declare openclaw.install.minHostVersion`,
      ).not.toBeNull();
      if (!requirement) {
        continue;
      }
      const minimum = parseSemver(requirement.minimumLabel);
      expect(minimum, `${relativePath} should use a parseable semver floor`).not.toBeNull();
      if (!minimum) {
        continue;
      }
      expect(
        isAtLeast(minimum, baseline),
        `${relativePath} should require at least OpenClaw ${MIN_HOST_VERSION_BASELINE}`,
      ).toBe(true);
    }
  });
});
