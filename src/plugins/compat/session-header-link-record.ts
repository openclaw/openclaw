import type { PluginCompatRecord } from "./types.js";

export const SESSION_HEADER_LINK_COMPAT_RECORD = {
  code: "plugin-sdk-session-header-link",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-10-01",
  deprecated: "2026-10-12",
  warningStarts: "2026-10-12",
  removeAfter: "2027-01-12",
  replacement:
    "Register a plugin-owned `session-header` accessory that renders its own content; the host no longer supplies session conversation-link metadata",
  docsPath: "/plugins/sdk-migration/compatibility-policy#session-header-link-helper",
  surfaces: ["openclaw/plugin-sdk/control-ui.createSessionHeaderLink"],
  diagnostics: ["TypeScript @deprecated annotation and shipped Plugin SDK surface check"],
  tests: ["src/plugins/compat/registry.test.ts"],
  releaseNote:
    "`createSessionHeaderLink` from 2026.10.1 remains importable but renders nothing, because session conversation links were retired.",
} as const satisfies PluginCompatRecord;
