// Defines node-host-local capability configuration types from the canonical schema.
import type { z } from "zod";
import type { McpServerConfig } from "./types.mcp.js";
import type { NodeHostSchema } from "./zod-schema.root-support.js";

type NodeHostSchemaInput = NonNullable<z.input<typeof NodeHostSchema>>;

export type NodeHostConfig = Omit<NodeHostSchemaInput, "mcp"> & {
  mcp?: {
    servers?: Record<string, McpServerConfig>;
  };
};

export type NodeHostBrowserProxyConfig = NonNullable<NodeHostConfig["browserProxy"]>;
