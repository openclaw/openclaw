import type { PluginCompatRecord } from "./types.js";

export const AGENT_LIST_RUNTIME_PROJECTION_COMPAT_RECORDS = [
  {
    code: "agent-list-runtime-projection",
    status: "deprecated",
    owner: "sdk",
    deprecated: "2026-10-02",
    warningStarts: "2026-10-02",
    removeAfter: "2027-01-02",
    replacement:
      "Canonical `cfg.agents.entries`, or `listAgentIds` / `resolveAgentConfig` from `openclaw/plugin-sdk/agent-runtime`",
    docsPath: "/plugins/sdk-migration/how-to-migrate#agent-roster-config",
    surfaces: ["non-enumerable runtime OpenClawConfig.agents.list projection"],
    diagnostics: ["plugin compatibility registry and migration documentation; no runtime warnings"],
  },
] as const satisfies readonly PluginCompatRecord[];
