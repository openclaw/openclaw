import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(SRC_ROOT, "..");

const CORE_SECRET_SURFACE_GUARDS = [
  {
    path: "src/secrets/runtime-config-collectors-channels.ts",
    forbiddenPatterns: [
      /["']irc["']/,
      /["']bluebubbles["']/,
      /["']msteams["']/,
      /["']nextcloud-talk["']/,
    ],
  },
  {
    path: "src/secrets/target-registry-data.ts",
    forbiddenPatterns: [
      /channels\.irc\./,
      /channels\.bluebubbles\./,
      /channels\.msteams\./,
      /channels\.nextcloud-talk\./,
    ],
  },
  {
    path: "src/config/markdown-tables.ts",
    forbiddenPatterns: [/["']signal["']/, /["']whatsapp["']/, /["']mattermost["']/],
  },
  {
    path: "src/plugin-sdk/channel-config-helpers.ts",
    forbiddenPatterns: [
      /\bresolveWhatsAppConfigAllowFrom\b/,
      /\bresolveWhatsAppConfigDefaultTo\b/,
      /\bresolveIMessageConfigAllowFrom\b/,
      /\bresolveIMessageConfigDefaultTo\b/,
      /\bformatWhatsAppConfigAllowFromEntries\b/,
    ],
  },
  {
    path: "src/config/bundled-channel-config-runtime.ts",
    forbiddenPatterns: [
      /\bstaticBundledChannelSchemas\b/,
      /\bMSTeamsConfigSchema\b/,
      /\bWhatsAppConfigSchema\b/,
    ],
  },
] as const;

describe("channel secret contract surface guardrails", () => {
  for (const entry of CORE_SECRET_SURFACE_GUARDS) {
    it(`keeps ${entry.path} free of moved channel-specific secret wiring`, () => {
      const source = readFileSync(resolve(REPO_ROOT, entry.path), "utf8");
      for (const pattern of entry.forbiddenPatterns) {
        expect(source).not.toMatch(pattern);
      }
    });
  }
});
