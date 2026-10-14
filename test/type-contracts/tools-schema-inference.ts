import type { ToolsConfig } from "../../src/config/types.tools.js";

void ([
  {},
  { search: {} },
  { search: { openaiCodex: { allowedDomains: [" example.com ", ""] } } },
  { fetch: { headers: { "X-Routing-Target": "internal" } } },
] satisfies NonNullable<ToolsConfig["web"]>[]);
