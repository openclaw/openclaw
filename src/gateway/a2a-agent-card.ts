import { listAgentEntries } from "../agents/agent-scope.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import type { OpenClawConfig } from "../config/types.js";
import type { GatewayA2aSkill } from "../config/types.gateway.js";

/**
 * A2A Agent Card as defined by the A2A Protocol specification.
 * @see https://a2a-protocol.org/latest/specification/
 */
export type A2aAgentCard = {
  name: string;
  description?: string;
  url: string;
  provider?: {
    name?: string;
    url?: string;
  };
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
  };
  skills: A2aAgentCardSkill[];
  securitySchemes?: Record<string, A2aSecurityScheme>;
  security?: Array<Record<string, string[]>>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
};

export type A2aAgentCardSkill = {
  id: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type A2aSecurityScheme = {
  type: string;
  name?: string;
  in?: string;
  scheme?: string;
};

/**
 * Build an A2A Agent Card from the OpenClaw config and gateway URL.
 */
export function buildAgentCard(cfg: OpenClawConfig, gatewayUrl: string): A2aAgentCard {
  const a2aCfg = cfg.gateway?.a2a;

  // Resolve agent name from config or first agent identity.
  let name = a2aCfg?.name;
  if (!name) {
    const agents = listAgentEntries(cfg);
    const defaultAgent = agents.find((a) => a.default) ?? agents[0];
    if (defaultAgent) {
      const identity = resolveAgentIdentity(cfg, defaultAgent.id);
      name = identity?.name ?? defaultAgent.name ?? defaultAgent.id;
    }
  }

  // Build skills list from config.
  const configSkills: GatewayA2aSkill[] = a2aCfg?.skills ?? [];
  const skills: A2aAgentCardSkill[] = configSkills.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    ...(s.inputSchema ? { inputSchema: s.inputSchema } : {}),
  }));

  // If no skills are explicitly configured, advertise a generic "chat" skill.
  if (skills.length === 0) {
    skills.push({
      id: "chat",
      name: "Chat",
      description: "General-purpose conversational agent",
    });
  }

  const baseUrl = (a2aCfg?.url ?? gatewayUrl).replace(/\/+$/, "");

  // Build security schemes based on auth config.
  const securitySchemes: Record<string, A2aSecurityScheme> = {};
  const security: Array<Record<string, string[]>> = [];

  if (a2aCfg?.auth?.apiKey) {
    securitySchemes.apiKey = {
      type: "apiKey",
      name: "x-api-key",
      in: "header",
    };
    security.push({ apiKey: [] });
  }
  if (a2aCfg?.auth?.bearerTokens) {
    securitySchemes.bearer = {
      type: "http",
      scheme: "bearer",
    };
    security.push({ bearer: [] });
  }

  return {
    name: name ?? "OpenClaw Agent",
    description: a2aCfg?.description,
    url: `${baseUrl}/a2a`,
    provider: a2aCfg?.provider,
    version: "0.2.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    skills,
    ...(Object.keys(securitySchemes).length > 0 ? { securitySchemes, security } : {}),
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };
}
