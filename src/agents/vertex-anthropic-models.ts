/**
 * Vertex AI Anthropic Claude Models Provider
 *
 * This module provides support for Claude models hosted on Google Cloud Vertex AI.
 * Uses gcloud ADC for authentication, eliminating the need for API keys.
 *
 * Benefits:
 * - Use GCP credits directly (no OpenRouter fee)
 * - Same Claude API experience as direct Anthropic
 * - Supports all Claude features (streaming, tools, thinking)
 */

import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { ProviderConfig } from "./models-config.providers.js";

// Vertex AI Claude model catalog
// Model IDs include version suffix as required by Vertex AI
const VERTEX_CLAUDE_MODELS: ModelDefinitionConfig[] = [
  {
    id: "claude-opus-4-5@20251101",
    name: "Claude Opus 4.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 32768,
    cost: {
      input: 15,
      output: 75,
      cacheRead: 1.875,
      cacheWrite: 18.75,
    },
  },
  {
    id: "claude-sonnet-4-5@20250929",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 16384,
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.375,
      cacheWrite: 3.75,
    },
  },
  {
    id: "claude-opus-4-1@20250805",
    name: "Claude Opus 4.1",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 32768,
    cost: {
      input: 15,
      output: 75,
      cacheRead: 1.875,
      cacheWrite: 18.75,
    },
  },
  {
    id: "claude-haiku-4-5@20251001",
    name: "Claude Haiku 4.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: {
      input: 0.8,
      output: 4,
      cacheRead: 0.1,
      cacheWrite: 1,
    },
  },
  {
    id: "claude-opus-4@20250514",
    name: "Claude Opus 4",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 32768,
    cost: {
      input: 15,
      output: 75,
      cacheRead: 1.875,
      cacheWrite: 18.75,
    },
  },
  {
    id: "claude-sonnet-4@20250514",
    name: "Claude Sonnet 4",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 16384,
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.375,
      cacheWrite: 3.75,
    },
  },
  {
    id: "claude-3-7-sonnet@20250219",
    name: "Claude 3.7 Sonnet",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 16384,
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.375,
      cacheWrite: 3.75,
    },
  },
  {
    id: "claude-3-5-sonnet-v2@20241022",
    name: "Claude 3.5 Sonnet v2",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.375,
      cacheWrite: 3.75,
    },
  },
  {
    id: "claude-3-5-haiku@20241022",
    name: "Claude 3.5 Haiku",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: {
      input: 0.8,
      output: 4,
      cacheRead: 0.1,
      cacheWrite: 1,
    },
  },
];

/**
 * Build the Vertex AI endpoint URL for Anthropic models
 */
export function buildVertexAnthropicBaseUrl(project: string, location: string): string {
  return `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/anthropic/models`;
}

/**
 * Resolve GCP project from environment
 */
export function resolveGcpProject(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.GOOGLE_CLOUD_PROJECT?.trim() ||
    env.GCLOUD_PROJECT?.trim() ||
    env.CLOUDSDK_CORE_PROJECT?.trim() ||
    undefined
  );
}

/**
 * Resolve GCP location from environment
 */
export function resolveGcpLocation(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.GOOGLE_CLOUD_LOCATION?.trim() ||
    env.CLOUDSDK_COMPUTE_REGION?.trim() ||
    // Default locations for Claude on Vertex
    undefined
  );
}

/**
 * Check if gcloud ADC credentials are available
 * Note: GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT alone are not credentials,
 * only GOOGLE_APPLICATION_CREDENTIALS provides auth
 */
export function hasGcloudAdc(env: NodeJS.ProcessEnv = process.env): boolean {
  // Only GOOGLE_APPLICATION_CREDENTIALS provides actual auth credentials
  // GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT are just project identifiers
  return !!env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
}

/**
 * Build the Vertex Anthropic provider configuration
 */
export function buildVertexAnthropicProvider(params: {
  project: string;
  location: string;
}): ProviderConfig {
  const baseUrl = buildVertexAnthropicBaseUrl(params.project, params.location);

  return {
    baseUrl,
    api: "anthropic-messages",
    auth: "token", // Uses gcloud ADC token
    models: VERTEX_CLAUDE_MODELS,
  };
}

/**
 * Resolve implicit Vertex Anthropic provider if GCP credentials are available
 */
export function resolveImplicitVertexAnthropicProvider(params: {
  env?: NodeJS.ProcessEnv;
}): ProviderConfig | null {
  const env = params.env ?? process.env;

  const project = resolveGcpProject(env);
  const location = resolveGcpLocation(env);

  // Need both project and location to use Vertex AI
  if (!project || !location) {
    return null;
  }

  // Check if we have GCP credentials (service account key file)
  if (!hasGcloudAdc(env)) {
    return null;
  }

  return buildVertexAnthropicProvider({ project, location });
}

/**
 * Get the list of available Vertex Claude models
 */
export function getVertexClaudeModels(): ModelDefinitionConfig[] {
  return [...VERTEX_CLAUDE_MODELS];
}
