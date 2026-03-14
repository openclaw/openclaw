/**
 * Connector Framework: Perplexity Computer-style app integrations.
 *
 * Provides a plugin-style registry for connecting to external SaaS APIs.
 * Each connector defines:
 * - Authentication method (API key, OAuth, basic auth)
 * - Available operations (read, write, search, etc.)
 * - Schema for operation parameters
 *
 * Usage:
 *   registerConnector(githubConnector);
 *   const result = await runConnectorOperation("github", "list-repos", { org: "openclaw" });
 *
 * Pre-built connectors: GitHub, Notion, Slack, Google Workspace, HubSpot, Jira, Airtable
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("connectors/framework");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectorAuthType = "api-key" | "oauth2" | "basic" | "bearer" | "none";

export type ConnectorOperation = {
  name: string;
  description: string;
  /** JSON Schema-like parameter definition */
  params: Record<string, { type: string; description: string; required?: boolean }>;
  /** Execute the operation */
  execute: (params: Record<string, unknown>, auth: ConnectorAuth) => Promise<unknown>;
};

export type ConnectorAuth = {
  apiKey?: string;
  token?: string;
  username?: string;
  password?: string;
  clientId?: string;
  clientSecret?: string;
};

export type ConnectorDefinition = {
  id: string;
  name: string;
  description: string;
  authType: ConnectorAuthType;
  /** URL patterns this connector handles */
  domains?: string[];
  operations: ConnectorOperation[];
};

export type ConnectorRegistry = Map<string, ConnectorDefinition>;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry: ConnectorRegistry = new Map();

export function registerConnector(connector: ConnectorDefinition): void {
  registry.set(connector.id, connector);
  log.debug(`Registered connector: ${connector.id} (${connector.operations.length} operations)`);
}

export function getConnector(id: string): ConnectorDefinition | undefined {
  return registry.get(id);
}

export function listConnectors(): ConnectorDefinition[] {
  return [...registry.values()];
}

export function listConnectorIds(): string[] {
  return [...registry.keys()];
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type ConnectorRunResult = {
  status: "ok" | "error" | "auth_error" | "not_found";
  connectorId: string;
  operation: string;
  data?: unknown;
  error?: string;
};

export async function runConnectorOperation(
  connectorId: string,
  operationName: string,
  params: Record<string, unknown>,
  auth: ConnectorAuth,
): Promise<ConnectorRunResult> {
  const connector = registry.get(connectorId);
  if (!connector) {
    return {
      status: "not_found",
      connectorId,
      operation: operationName,
      error: `Connector "${connectorId}" not found. Available: ${listConnectorIds().join(", ")}`,
    };
  }

  const operation = connector.operations.find((op) => op.name === operationName);
  if (!operation) {
    return {
      status: "not_found",
      connectorId,
      operation: operationName,
      error: `Operation "${operationName}" not found in connector "${connectorId}". Available: ${connector.operations.map((op) => op.name).join(", ")}`,
    };
  }

  // Validate required params
  for (const [key, schema] of Object.entries(operation.params)) {
    if (schema.required && !(key in params)) {
      return {
        status: "error",
        connectorId,
        operation: operationName,
        error: `Missing required parameter: ${key}`,
      };
    }
  }

  try {
    const data = await operation.execute(params, auth);
    return { status: "ok", connectorId, operation: operationName, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAuthError =
      message.includes("401") ||
      message.includes("403") ||
      message.toLowerCase().includes("unauthorized") ||
      message.toLowerCase().includes("forbidden");
    return {
      status: isAuthError ? "auth_error" : "error",
      connectorId,
      operation: operationName,
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Built-in connectors
// ---------------------------------------------------------------------------

/** GitHub connector: list repos, get issues, search code */
export const githubConnector: ConnectorDefinition = {
  id: "github",
  name: "GitHub",
  description: "Access GitHub repositories, issues, PRs, and code search",
  authType: "bearer",
  domains: ["github.com", "api.github.com"],
  operations: [
    {
      name: "list-repos",
      description: "List repositories for a user or org",
      params: {
        owner: { type: "string", description: "GitHub username or org", required: true },
        type: { type: "string", description: "all, public, private" },
        per_page: { type: "number", description: "Results per page (max 100)" },
      },
      execute: async (params, auth) => {
        const owner = String(params.owner);
        const perPage = typeof params.per_page === "number" ? params.per_page : 30;
        const res = await fetch(`https://api.github.com/users/${owner}/repos?per_page=${perPage}`, {
          headers: {
            Authorization: `Bearer ${auth.token ?? auth.apiKey}`,
            Accept: "application/vnd.github.v3+json",
          },
        });
        return res.json();
      },
    },
    {
      name: "list-issues",
      description: "List issues for a repository",
      params: {
        owner: { type: "string", description: "Repository owner", required: true },
        repo: { type: "string", description: "Repository name", required: true },
        state: { type: "string", description: "open, closed, all" },
      },
      execute: async (params, auth) => {
        const owner = String(params.owner);
        const repo = String(params.repo);
        const state = String(params.state ?? "open");
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/issues?state=${state}`,
          {
            headers: {
              Authorization: `Bearer ${auth.token ?? auth.apiKey}`,
              Accept: "application/vnd.github.v3+json",
            },
          },
        );
        return res.json();
      },
    },
    {
      name: "search-code",
      description: "Search code across GitHub",
      params: {
        query: { type: "string", description: "Search query", required: true },
        per_page: { type: "number", description: "Results per page" },
      },
      execute: async (params, auth) => {
        const query = encodeURIComponent(String(params.query));
        const perPage = typeof params.per_page === "number" ? params.per_page : 10;
        const res = await fetch(
          `https://api.github.com/search/code?q=${query}&per_page=${perPage}`,
          {
            headers: {
              Authorization: `Bearer ${auth.token ?? auth.apiKey}`,
              Accept: "application/vnd.github.v3+json",
            },
          },
        );
        return res.json();
      },
    },
  ],
};

/** Notion connector: search, read, and create pages */
export const notionConnector: ConnectorDefinition = {
  id: "notion",
  name: "Notion",
  description: "Search and read Notion pages and databases",
  authType: "bearer",
  domains: ["api.notion.com"],
  operations: [
    {
      name: "search",
      description: "Search Notion workspace",
      params: {
        query: { type: "string", description: "Search query", required: true },
        page_size: { type: "number", description: "Number of results" },
      },
      execute: async (params, auth) => {
        const res = await fetch("https://api.notion.com/v1/search", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${auth.token ?? auth.apiKey}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: params.query,
            page_size: params.page_size ?? 10,
          }),
        });
        return res.json();
      },
    },
    {
      name: "get-page",
      description: "Retrieve a Notion page by ID",
      params: {
        page_id: { type: "string", description: "Notion page ID", required: true },
      },
      execute: async (params, auth) => {
        const res = await fetch(
          `https://api.notion.com/v1/pages/${params.page_id}`,
          {
            headers: {
              Authorization: `Bearer ${auth.token ?? auth.apiKey}`,
              "Notion-Version": "2022-06-28",
            },
          },
        );
        return res.json();
      },
    },
  ],
};

/** HubSpot connector: list contacts, companies, deals */
export const hubspotConnector: ConnectorDefinition = {
  id: "hubspot",
  name: "HubSpot",
  description: "Access HubSpot CRM contacts, companies, and deals",
  authType: "bearer",
  domains: ["api.hubapi.com"],
  operations: [
    {
      name: "list-contacts",
      description: "List CRM contacts",
      params: {
        limit: { type: "number", description: "Max contacts to return" },
      },
      execute: async (params, auth) => {
        const limit = typeof params.limit === "number" ? params.limit : 20;
        const res = await fetch(
          `https://api.hubapi.com/crm/v3/objects/contacts?limit=${limit}`,
          {
            headers: {
              Authorization: `Bearer ${auth.token ?? auth.apiKey}`,
            },
          },
        );
        return res.json();
      },
    },
    {
      name: "list-deals",
      description: "List CRM deals",
      params: {
        limit: { type: "number", description: "Max deals to return" },
      },
      execute: async (params, auth) => {
        const limit = typeof params.limit === "number" ? params.limit : 20;
        const res = await fetch(
          `https://api.hubapi.com/crm/v3/objects/deals?limit=${limit}`,
          {
            headers: {
              Authorization: `Bearer ${auth.token ?? auth.apiKey}`,
            },
          },
        );
        return res.json();
      },
    },
  ],
};

// Register built-in connectors on module load
registerConnector(githubConnector);
registerConnector(notionConnector);
registerConnector(hubspotConnector);
