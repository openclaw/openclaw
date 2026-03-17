export type McpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string | number | boolean>;
  cwd?: string;
  workingDirectory?: string;
  url?: string;
  /** Optional MCPS (MCP Secure) cryptographic signing configuration. */
  mcps?: {
    /** Enable MCPS message signing for this server. Default: false. */
    enabled?: boolean;
    /** Reject unsigned responses from this server. Default: false (permissive). */
    requireSecurity?: boolean;
    /** Server's public key (PEM) for response verification. Auto-discovered if omitted. */
    publicKey?: string;
  };
  [key: string]: unknown;
};

export type McpConfig = {
  /** Named MCP server definitions managed by OpenClaw. */
  servers?: Record<string, McpServerConfig>;
};
