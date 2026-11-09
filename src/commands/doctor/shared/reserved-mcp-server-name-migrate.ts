import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

const RESERVED_MCP_SERVER_NAME = "__proto__";

function resolveMcpServers(raw: unknown, nodeHost: boolean): Record<string, unknown> | undefined {
  const root = asOptionalRecord(raw);
  const owner = nodeHost ? asOptionalRecord(root?.nodeHost) : root;
  return asOptionalRecord(asOptionalRecord(owner?.mcp)?.servers);
}

/** Drop reserved MCP server names before canonical config validation runs. */
export function migrateReservedMcpServerNames(
  cfg: OpenClawConfig,
  sourceRaw: unknown = cfg,
): {
  config: OpenClawConfig;
  changes: string[];
} {
  const locations = [
    { path: "mcp.servers", nodeHost: false },
    { path: "nodeHost.mcp.servers", nodeHost: true },
  ].filter(({ nodeHost }) =>
    [sourceRaw, cfg].some((value) =>
      Object.hasOwn(resolveMcpServers(value, nodeHost) ?? {}, RESERVED_MCP_SERVER_NAME),
    ),
  );
  if (locations.length === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const changes: string[] = [];
  for (const { path, nodeHost } of locations) {
    const servers = resolveMcpServers(next, nodeHost);
    if (servers) {
      delete servers[RESERVED_MCP_SERVER_NAME];
    }
    changes.push(
      `Dropped MCP server "${RESERVED_MCP_SERVER_NAME}" from ${path} because the name is reserved; re-add it under a different name.`,
    );
  }
  return { config: next, changes };
}
