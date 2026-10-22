import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WEB_PLUGIN_KEY =
  /plugins\.entries\.(?:brave|google|exa|xai|moonshot|perplexity|firecrawl|tavily|minimax)\.config\.web(?:Search|Fetch)\.apiKey/;

const CORE_SECRET_SURFACE_GUARDS = [
  [
    "src/secrets/runtime-config-collectors-channels.ts",
    [/["']irc["']/, /["']imessage["']/, /["']msteams["']/, /["']nextcloud-talk["']/],
  ],
  [
    "src/secrets/target-registry-data.ts",
    [
      /channels\.irc\./,
      /channels\.imessage\./,
      /channels\.msteams\./,
      /channels\.nextcloud-talk\./,
      WEB_PLUGIN_KEY,
    ],
  ],
  ["src/cli/command-secret-targets.ts", [WEB_PLUGIN_KEY]],
  ["src/config/markdown-tables.ts", [/["']signal["']/, /["']whatsapp["']/, /["']mattermost["']/]],
  [
    "src/plugin-sdk/channel-config-helpers.ts",
    [
      /\bresolveWhatsAppConfigAllowFrom\b/,
      /\bresolveWhatsAppConfigDefaultTo\b/,
      /\bresolveIMessageConfigAllowFrom\b/,
      /\bresolveIMessageConfigDefaultTo\b/,
      /\bformatWhatsAppConfigAllowFromEntries\b/,
    ],
  ],
  ["src/gateway/channel-health-policy.ts", [/\btelegram\b/]],
  ["src/channels/model-overrides.ts", [/\bfeishu\b/]],
  ["src/config/sessions/group.ts", [/\bwhatsapp\b/, /@g\.us/]],
  ["src/channels/conversation-label.ts", [/@g\.us/]],
  ["src/auto-reply/command-auth.ts", [/@g\.us/]],
  ["src/channels/plugins/setup-promotion-helpers.ts", [/\btelegram\b/]],
  ["src/flows/search-setup.ts", [/\bbrave\b/]],
  ["src/web-search/runtime.ts", [/\bbrave\b/]],
  [
    "src/media-understanding/defaults.ts",
    [
      /\b(?:openai|anthropic|google|groq|deepgram|mistral|minimax|zai|qwen|moonshot|openrouter)\b/,
      /\b(?:gpt-|claude-|gemini-|whisper-|nova-|voxtral-|MiniMax-|glm-|qwen-|kimi-)\b/,
    ],
  ],
] as const;

describe("channel secret contract surface guardrails", () => {
  for (const [file, forbiddenPatterns] of CORE_SECRET_SURFACE_GUARDS) {
    it(`keeps ${file} free of moved channel-specific secret wiring`, () => {
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      for (const pattern of forbiddenPatterns) {
        expect(source).not.toMatch(pattern);
      }
    });
  }
});
