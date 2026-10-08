import type { PluginCompatRecord } from "./types.js";

export const CHANNEL_PAIRING_COMPAT_RECORD = {
  code: "channel-pairing-sync-allowlist",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-04-03",
  deprecated: "2026-10-03",
  warningStarts: "2026-10-03",
  removalGate: "next-plugin-sdk-major",
  replacement:
    "Await readChannelAllowFromStore from channel-pairing. The released synchronous reader retains its signature and native behavior until the next Plugin SDK major and explicit breaking-release approval.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#channel-pairing-allowlists",
  surfaces: ["openclaw/plugin-sdk/channel-pairing.readChannelAllowFromStoreSync"],
  diagnostics: [
    "TypeScript @deprecated annotation and migration documentation; no runtime warnings",
  ],
  tests: [
    "src/plugins/compat/registry.test.ts",
    "src/plugin-sdk/channel-pairing-allowlist.test.ts",
    "src/pairing/pairing-allowlist.worker.test.ts",
  ],
  releaseNote:
    "Channel ingress reads pairing allowlists through the shared-state reader. Bundled callers await the existing async API; the synchronous SDK reader remains compatible. Missing-store reads grant no permission and no longer initialize storage.",
} as const satisfies PluginCompatRecord;
