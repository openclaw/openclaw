/**
 * Cloud.ru AI Fabric — Types
 *
 * TypeScript types for the Cloud.ru AI Agents REST API.
 * Derived from API documentation in docs/ccli-max-cloudru-fm/research/.
 */

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type CloudruAuthConfig = {
  keyId: string;
  secret: string;
};

export type CloudruTokenResponse = {
  token: string;
  expiresAt: string; // ISO 8601
};

export type ResolvedToken = {
  token: string;
  expiresAt: number; // epoch ms
};

// ---------------------------------------------------------------------------
// Client config
// ---------------------------------------------------------------------------

export type CloudruClientConfig = {
  projectId: string;
  auth: CloudruAuthConfig;
  /** Override AI Agents base URL (for testing). */
  baseUrl?: string;
  /** Override IAM token URL (for testing). */
  iamUrl?: string;
  /** HTTP request timeout in ms. */
  timeoutMs?: number;
  /** Custom fetch implementation (for testing). */
  fetchImpl?: typeof fetch;
};

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export type PaginationParams = {
  limit?: number;
  offset?: number;
};

export type PaginatedResult<T> = {
  data: T[];
  total: number;
};

// ---------------------------------------------------------------------------
// Agent status
// ---------------------------------------------------------------------------

export type AgentStatus =
  | "UNKNOWN"
  | "RESOURCE_ALLOCATION"
  | "PULLING"
  | "RUNNING"
  | "ON_SUSPENSION"
  | "SUSPENDED"
  | "ON_DELETION"
  | "DELETED"
  | "FAILED"
  | "COOLED"
  | "LLM_UNAVAILABLE"
  | "TOOL_UNAVAILABLE"
  | "IMAGE_UNAVAILABLE";

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export type AgentToolDefinition = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type AgentOptions = {
  modelId: string;
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number;
  tools?: AgentToolDefinition[];
};

export type AgentScalingConfig = {
  minInstances: number;
  maxInstances: number;
  scalingType?: "rps" | "concurrency";
  targetValue?: number;
  keepAliveSeconds?: number;
  idleTimeoutSeconds?: number;
};

export type AgentIntegrationOptions = {
  scaling?: AgentScalingConfig;
  auth?: Record<string, unknown>;
  logging?: { enabled?: boolean };
};

export type CreateAgentParams = {
  name: string;
  description?: string;
  instanceTypeId: string;
  options: AgentOptions;
  mcpServerId?: string[];
  integrationOptions?: AgentIntegrationOptions;
};

export type UpdateAgentParams = Partial<CreateAgentParams>;

export type Agent = {
  id: string;
  name: string;
  description?: string;
  status: AgentStatus;
  endpoint?: string;
  instanceTypeId?: string;
  options?: AgentOptions;
  mcpServerId?: string[];
  integrationOptions?: AgentIntegrationOptions;
  createdAt: string;
  updatedAt: string;
};

export type ListAgentsParams = PaginationParams & {
  search?: string;
  status?: AgentStatus;
};

// ---------------------------------------------------------------------------
// Agent System status
// ---------------------------------------------------------------------------

export type AgentSystemStatus =
  | "UNKNOWN"
  | "RESOURCE_ALLOCATION"
  | "PULLING"
  | "RUNNING"
  | "ON_SUSPENSION"
  | "SUSPENDED"
  | "ON_DELETION"
  | "DELETED"
  | "FAILED"
  | "COOLED"
  | "AGENT_UNAVAILABLE";

// ---------------------------------------------------------------------------
// Agent System
// ---------------------------------------------------------------------------

export type OrchestratorOptions = {
  type: string;
  modelId: string;
  routingStrategy?: string;
  maxConcurrentTasks?: number;
  timeoutSeconds?: number;
};

export type AgentSystemMember = {
  agentId: string;
  role?: string;
  weight?: number;
};

export type CreateAgentSystemParams = {
  name: string;
  description?: string;
  instanceTypeId: string;
  orchestratorOptions: OrchestratorOptions;
  options: {
    agents: AgentSystemMember[];
  };
  integrationOptions?: {
    scaling?: { minInstances: number; maxInstances: number };
    logging?: { enabled?: boolean };
  };
};

export type UpdateAgentSystemParams = Partial<CreateAgentSystemParams>;

export type AgentSystem = {
  id: string;
  name: string;
  description?: string;
  status: AgentSystemStatus;
  instanceTypeId?: string;
  orchestratorOptions?: OrchestratorOptions;
  options?: {
    agents: AgentSystemMember[];
  };
  createdAt: string;
  updatedAt: string;
};

export type ListAgentSystemsParams = PaginationParams & {
  search?: string;
  status?: AgentSystemStatus;
};

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

export type McpServerStatus =
  | "UNKNOWN"
  | "ON_RESOURCE_ALLOCATION"
  | "AVAILABLE"
  | "IMAGE_UNAVAILABLE"
  | "WAITING_FOR_SCRAPPING"
  | "ON_DELETION"
  | "DELETED"
  | "ON_SUSPENDING"
  | "SUSPENDED"
  | "FAILED"
  | "RUNNING"
  | "COOLED";

export type McpTool = {
  name: string;
  description: string;
};

export type McpServer = {
  id: string;
  name: string;
  status: McpServerStatus;
  tools: McpTool[];
  createdAt: string;
};

export type ListMcpServersParams = PaginationParams & {
  search?: string;
};

// ---------------------------------------------------------------------------
// Instance Type
// ---------------------------------------------------------------------------

export type InstanceType = {
  id: string;
  name: string;
  cpu: number;
  memoryGb: number;
  gpu: string | null;
  pricePerHour: number;
};

// ---------------------------------------------------------------------------
// API error
// ---------------------------------------------------------------------------

export type CloudruApiErrorPayload = {
  message?: string;
  code?: string;
  details?: unknown;
};
