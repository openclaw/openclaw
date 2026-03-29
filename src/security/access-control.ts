import type { OpenClawConfig } from "../config/config.js";
import type { AnyAgentTool } from "../agents/tools/common.js";

export type AccessLevel = "read" | "write" | "admin" | "owner";
export type ResourceType = "tools" | "channels" | "agents" | "files" | "config";

export interface AccessPolicy {
  id: string;
  name: string;
  description: string;
  rules: AccessRule[];
  priority: number;
  enabled: boolean;
}

export interface AccessRule {
  resource: ResourceType;
  resourceId?: string;
  accessLevel: AccessLevel;
  conditions: AccessCondition[];
  effect: "allow" | "deny";
}

export interface AccessCondition {
  type: "user" | "agent" | "channel" | "time" | "ip" | "custom";
  operator: "equals" | "contains" | "regex" | "in" | "not_in";
  value: string | string[];
  caseSensitive?: boolean;
}

export interface SecurityContext {
  userId?: string;
  agentId?: string;
  channelId?: string;
  sessionId?: string;
  ipAddress?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export class AccessControlManager {
  private policies: Map<string, AccessPolicy> = new Map();
  private config: OpenClawConfig;

  constructor(config: OpenClawConfig) {
    this.config = config;
    this.loadDefaultPolicies();
  }

  /**
   * Check if access is allowed for a specific resource and context
   */
  checkAccess(
    resource: ResourceType,
    resourceId: string | undefined,
    accessLevel: AccessLevel,
    context: SecurityContext
  ): { allowed: boolean; reason: string; policy?: string } {
    const applicablePolicies = this.getApplicablePolicies(resource, resourceId);
    
    // Sort by priority (higher first)
    applicablePolicies.sort((a, b) => b.priority - a.priority);

    for (const policy of applicablePolicies) {
      for (const rule of policy.rules) {
        if (this.matchesRule(rule, resource, resourceId, context)) {
          const allowed = rule.effect === "allow" && 
                        this.hasRequiredAccessLevel(rule.accessLevel, accessLevel);
          
          return {
            allowed,
            reason: `${policy.name}: ${rule.effect} - ${rule.resource}:${rule.accessLevel}`,
            policy: policy.id
          };
        }
      }
    }

    // Default deny
    return {
      allowed: false,
      reason: "No matching policy found - access denied by default"
    };
  }

  /**
   * Filter tools based on access control
   */
  filterTools(tools: AnyAgentTool[], context: SecurityContext): AnyAgentTool[] {
    return tools.filter(tool => {
      const access = this.checkAccess("tools", tool.name, "write", context);
      return access.allowed;
    });
  }

  /**
   * Add or update an access policy
   */
  upsertPolicy(policy: AccessPolicy): void {
    this.policies.set(policy.id, policy);
  }

  /**
   * Remove an access policy
   */
  removePolicy(policyId: string): boolean {
    return this.policies.delete(policyId);
  }

  /**
   * List all policies
   */
  listPolicies(): AccessPolicy[] {
    return Array.from(this.policies.values());
  }

  private loadDefaultPolicies(): void {
    // Owner has full access
    this.policies.set("owner-full-access", {
      id: "owner-full-access",
      name: "Owner Full Access",
      description: "Owner has unrestricted access to all resources",
      priority: 1000,
      enabled: true,
      rules: [
        {
          resource: "tools" as ResourceType,
          accessLevel: "owner" as AccessLevel,
          effect: "allow" as const,
          conditions: [
            {
              type: "user" as const,
              operator: "equals" as const,
              value: "owner"
            }
          ]
        },
        {
          resource: "channels" as ResourceType,
          accessLevel: "owner" as AccessLevel,
          effect: "allow" as const,
          conditions: [
            {
              type: "user" as const,
              operator: "equals" as const,
              value: "owner"
            }
          ]
        }
      ]
    });

    // Agent sandbox restrictions
    this.policies.set("agent-sandbox-restrictions", {
      id: "agent-sandbox-restrictions",
      name: "Agent Sandbox Restrictions",
      description: "Restrict agent access to dangerous tools",
      priority: 900,
      enabled: true,
      rules: [
        {
          resource: "tools" as ResourceType,
          resourceId: "bash",
          accessLevel: "write" as AccessLevel,
          effect: "deny" as const,
          conditions: [
            {
              type: "agent" as const,
              operator: "not_in" as const,
              value: ["main"]
            }
          ]
        },
        {
          resource: "tools" as ResourceType,
          resourceId: "system.run",
          accessLevel: "write" as AccessLevel,
          effect: "deny" as const,
          conditions: [
            {
              type: "agent" as const,
              operator: "not_in" as const,
              value: ["main"]
            }
          ]
        }
      ]
    });
  }

  private getApplicablePolicies(resource: ResourceType, resourceId?: string): AccessPolicy[] {
    return Array.from(this.policies.values()).filter(policy => 
      policy.enabled && policy.rules.some(rule => 
        rule.resource === resource && 
        (!rule.resourceId || rule.resourceId === resourceId)
      )
    );
  }

  private matchesRule(
    rule: AccessRule,
    resource: ResourceType,
    resourceId: string | undefined,
    context: SecurityContext
  ): boolean {
    if (rule.resource !== resource) return false;
    if (rule.resourceId && rule.resourceId !== resourceId) return false;

    return rule.conditions.every(condition => 
      this.evaluateCondition(condition, context)
    );
  }

  private evaluateCondition(condition: AccessCondition, context: SecurityContext): boolean {
    switch (condition.type) {
      case "user":
        return this.evaluateStringCondition(condition, context.userId);
      case "agent":
        return this.evaluateStringCondition(condition, context.agentId);
      case "channel":
        return this.evaluateStringCondition(condition, context.channelId);
      case "time":
        return this.evaluateTimeCondition(condition, context.timestamp);
      case "ip":
        return this.evaluateStringCondition(condition, context.ipAddress);
      case "custom":
        // Custom conditions can be evaluated by plugins
        return true; // Placeholder for custom logic
      default:
        return false;
    }
  }

  private evaluateStringCondition(condition: AccessCondition, value?: string): boolean {
    if (!value && condition.operator !== "not_in") return false;

    switch (condition.operator) {
      case "equals":
        return value === condition.value;
      case "contains":
        return value?.includes(condition.value as string) ?? false;
      case "regex":
        return new RegExp(condition.value as string, condition.caseSensitive ? "g" : "gi").test(value || "");
      case "in":
        return Array.isArray(condition.value) ? condition.value.includes(value || "") : false;
      case "not_in":
        return Array.isArray(condition.value) ? !condition.value.includes(value || "") : true;
      default:
        return false;
    }
  }

  private evaluateTimeCondition(condition: AccessCondition, timestamp: number): boolean {
    // Placeholder for time-based conditions
    return true;
  }

  private hasRequiredAccessLevel(required: AccessLevel, requested: AccessLevel): boolean {
    const levels: Record<AccessLevel, number> = {
      read: 1,
      write: 2,
      admin: 3,
      owner: 4
    };
    return levels[requested] >= levels[required];
  }
}
