/**
 * Shared types for parsed tool policy data.
 */

export interface ToolDefinition {
  id: string;
  sectionId: string;
  profiles: string[];
  includeInOpenClawGroup: boolean;
}

export interface SectionOrder {
  id: string;
  label: string;
}

export interface ParsedToolCatalog {
  tools: ToolDefinition[];
  sectionOrder: SectionOrder[];
}

export interface ParsedPolicies {
  aliases: Record<string, string>;
  ownerOnlyFallbacks: string[];
  subagentDenyAlways: string[];
  subagentDenyLeaf: string[];
  extraTools: string[];
}

export interface PipelineStep {
  label: string;
  paramName: string;
  stripPluginOnlyAllowlist: boolean;
}

export interface ParsedPipeline {
  steps: PipelineStep[];
}

export interface ParsedAll {
  catalog: ParsedToolCatalog;
  policies: ParsedPolicies;
  pipeline: ParsedPipeline;
}
