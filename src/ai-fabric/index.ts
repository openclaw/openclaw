/**
 * Cloud.ru AI Fabric — Public API
 *
 * Barrel exports for the ai-fabric module.
 * Usage: import { CloudruClient, CloudruAgentsClient, ... } from "./ai-fabric/index.js";
 */

// Constants
export {
  CLOUDRU_AI_AGENTS_BASE_URL,
  CLOUDRU_IAM_TOKEN_URL,
  CLOUDRU_DEFAULT_TIMEOUT_MS,
  CLOUDRU_TOKEN_REFRESH_MARGIN_MS,
  CLOUDRU_RETRY_DEFAULTS,
  CLOUDRU_DEFAULT_PAGE_SIZE,
} from "./constants.js";

// Types
export type {
  CloudruAuthConfig,
  CloudruTokenResponse,
  ResolvedToken,
  CloudruClientConfig,
  PaginationParams,
  PaginatedResult,
  AgentStatus,
  Agent,
  AgentToolDefinition,
  AgentOptions,
  AgentScalingConfig,
  AgentIntegrationOptions,
  CreateAgentParams,
  UpdateAgentParams,
  ListAgentsParams,
  AgentSystemStatus,
  AgentSystem,
  OrchestratorOptions,
  AgentSystemMember,
  CreateAgentSystemParams,
  UpdateAgentSystemParams,
  ListAgentSystemsParams,
  McpServerStatus,
  McpTool,
  McpServer,
  ListMcpServersParams,
  InstanceType,
  CloudruApiErrorPayload,
} from "./types.js";

// Auth
export { CloudruTokenProvider, CloudruAuthError } from "./cloudru-auth.js";
export type { CloudruAuthOptions } from "./cloudru-auth.js";

// Client
export { CloudruClient, CloudruApiError } from "./cloudru-client.js";

// Simple client (wizard flows)
export { CloudruSimpleClient } from "./cloudru-client-simple.js";
export type { CloudruSimpleClientConfig } from "./cloudru-client-simple.js";

// Domain clients
export { CloudruAgentsClient } from "./cloudru-agents-client.js";
export { CloudruAgentSystemsClient } from "./cloudru-agent-systems-client.js";
export { CloudruMcpClient } from "./cloudru-mcp-client.js";

// Agent status monitoring
export { getAgentStatus, mapAgentHealth } from "./agent-status.js";
export type {
  AgentHealth,
  AgentStatusParams,
  AgentStatusEntry,
  AgentStatusSummary,
  AgentStatusResult,
  AgentStatusError,
  AgentStatusErrorType,
} from "./agent-status.js";

// MCP server status monitoring
export { getMcpServerStatus, mapMcpServerHealth } from "./mcp-status.js";
export type {
  McpServerHealth,
  McpStatusParams,
  McpStatusEntry,
  McpStatusSummary,
  McpStatusResult,
  McpStatusError,
  McpStatusErrorType,
} from "./mcp-status.js";

// A2A client
export { CloudruA2AClient, A2AError } from "./cloudru-a2a-client.js";
export type {
  A2AClientConfig,
  A2AMessage,
  A2AMessagePart,
  A2ASendParams,
  A2ASendResult,
  A2ATaskResponse,
} from "./cloudru-a2a-client.js";
