// Telegram plugin-sdk facade.
//
// Restored as part of PR #68939 follow-up after the upstream
// `refactor: drop private channel sdk facades` (commit d3eeadba94)
// removed `src/plugin-sdk/telegram.ts` along with the discord/slack
// counterparts. The C2 commit in this stack
// (`feat(plan-mode): C2 Telegram PR-14 re-wire`) re-wired the
// plan-archetype bridge to dynamic-import this facade for the
// `sendDocumentTelegram` runtime entrypoint, but the file itself
// was missing — at runtime the bridge logged
// `Cannot find module '/private/tmp/plugin-sdk/telegram.js'` and
// the markdown attachment delivery was skipped on every plan submit.
//
// This minimal restoration re-exports the symbols the plan-mode
// bridge uses (`TelegramDocumentOpts` type + `sendDocumentTelegram`
// runtime function) via the existing facade-loader pattern that
// resolves bundled plugin public surface modules at run time.
// Other channel facades (Discord, Slack) stay dropped per the
// upstream intent — only Telegram is restored because it's the
// single hard dependency of the plan-mode bridge today.
//
// If a future upstream pass re-removes channel facades, the bridge
// will need to migrate to the channel-runtime registry pattern
// instead of dynamic-importing this facade directly.

import { loadBundledPluginPublicSurfaceModule } from "./facade-loader.js";

// PR-14: re-export the option type so core callers can type their
// dispatch shape without importing from the plugin package directly.
export type { TelegramDocumentOpts } from "@openclaw/telegram/runtime-api.js";

type RuntimeApiModule = typeof import("@openclaw/telegram/runtime-api.js");

/**
 * PR-14: lazy-load the Telegram runtime API for the plan-mode bridge.
 * Async + lazy so callers (e.g. the plan-archetype bridge that fires
 * only on `exit_plan_mode` in a Telegram session) don't pay the
 * Telegram-bundle startup cost on cold paths.
 */
async function loadRuntimeApiModule(): Promise<RuntimeApiModule> {
  return await loadBundledPluginPublicSurfaceModule<RuntimeApiModule>({
    dirName: "telegram",
    artifactBasename: "runtime-api.js",
  });
}

/**
 * PR-14: send a local file as a Telegram document attachment. Used by
 * the plan-mode bridge to deliver markdown plan files to chats so
 * users can read the full plan archetype on their primary platform.
 *
 * Resolution stays text-based via PR-11's universal /plan slash
 * commands (works across all channels), sidestepping the dual-id
 * problem of bridging inline-button approvals through the gateway
 * plugin-approval pipeline.
 */
export const sendDocumentTelegram: RuntimeApiModule["sendDocumentTelegram"] = (async (...args) =>
  (await loadRuntimeApiModule()).sendDocumentTelegram(
    ...args,
  )) as RuntimeApiModule["sendDocumentTelegram"];
