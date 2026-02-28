/**
 * Configuration for local-model-only security mode.
 *
 * When enabled, the gateway enforces that all model inference stays within
 * the corporate LAN—no API calls leave the network boundary. This is
 * designed for air-gapped or security-sensitive internal deployments that
 * use local model servers (Ollama, vLLM, etc.) exclusively.
 */

export type LocalModelSecurityMode = "off" | "enforced" | "audit";

export type AllowedLocalHost = {
  /** Hostname or IP (e.g. "ollama-server.lan", "192.168.1.100"). */
  host: string;
  /** Optional port restriction (e.g. 11434). When omitted, any port is allowed. */
  port?: number;
  /** Human-readable label for logs and audit output. */
  label?: string;
};

export type NetworkEgressPolicy = {
  /**
   * When true, block ALL outbound HTTP/HTTPS requests to hosts outside the
   * allowedHosts list. Model providers, web search tools, and fetch calls
   * are all subject to this policy.
   */
  blockExternalRequests?: boolean;

  /**
   * Hosts that are permitted even in local-only mode.
   * Typically your local Ollama/vLLM servers.
   */
  allowedHosts?: AllowedLocalHost[];

  /**
   * CIDR ranges considered "local" (default: RFC 1918 + link-local).
   * Requests to these ranges are always allowed unless explicitly blocked.
   */
  allowedCidrRanges?: string[];

  /**
   * Block DNS resolution that would reach external resolvers.
   * When true, only /etc/hosts and local DNS are used.
   */
  blockExternalDns?: boolean;
};

export type LocalProviderConfig = {
  /** Provider type: "ollama" | "vllm" | "custom-openai" */
  type: "ollama" | "vllm" | "custom-openai";
  /** Base URL of the local model server. */
  baseUrl: string;
  /** Optional API key for the local server. */
  apiKey?: string;
  /** Human-readable name for this provider instance. */
  name?: string;
  /**
   * Require TLS even for LAN connections.
   * Default: false (plain HTTP allowed for loopback/LAN).
   */
  requireTls?: boolean;
};

export type LocalModelSecurityConfig = {
  /**
   * Security mode:
   * - "off": no restrictions (default)
   * - "enforced": block all external model API calls; only local providers allowed
   * - "audit": log violations but don't block (dry-run)
   */
  mode?: LocalModelSecurityMode;

  /** Network egress restrictions. */
  networkEgress?: NetworkEgressPolicy;

  /** Pre-configured local model providers. */
  localProviders?: LocalProviderConfig[];

  /**
   * Block cloud provider APIs entirely (Anthropic, OpenAI, Google, etc.).
   * Overrides any configured cloud provider keys.
   * Default: true when mode is "enforced".
   */
  blockCloudProviders?: boolean;

  /**
   * Block web search and web fetch tools.
   * Default: true when mode is "enforced".
   */
  blockWebAccess?: boolean;

  /**
   * Block telemetry and update checks that phone home.
   * Default: true when mode is "enforced".
   */
  blockTelemetry?: boolean;

  /**
   * Require all local provider connections to use TLS.
   * For high-security LANs with internal CAs.
   * Default: false.
   */
  requireTls?: boolean;

  /**
   * Additional TLS CA certificate path for verifying local servers.
   * Useful when local servers use internal CA-signed certs.
   */
  tlsCaPath?: string;
};
