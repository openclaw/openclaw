import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { logDebug } from "../../logger.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const CONTEXT_ACTIONS = [
  "analyze",
  "optimize",
  "summarize",
  "compress",
  "cleanup",
] as const;

const CONTEXT_TYPES = [
  "session",
  "memory",
  "tool_calls",
  "messages",
  "all",
] as const;

interface ContextAnalysisResult {
  totalItems: number;
  estimatedTokens: number;
  oldestItem?: string;
  newestItem?: string;
  recommendations: string[];
  compressionRatio?: number;
}

interface ContextOptimizationResult {
  originalSize: number;
  optimizedSize: number;
  compressionRatio: number;
  itemsRemoved: number;
  processingTimeMs: number;
}

export function createContextManagementTool(
  config?: OpenClawConfig,
): AnyAgentTool {
  return {
    name: "context_management",
    label: "Context Management",
    description: "Analyze and optimize AI agent context, memory, and session data for better performance",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: CONTEXT_ACTIONS,
          description: "Action to perform on the context",
        },
        contextType: {
          type: "string",
          enum: CONTEXT_TYPES,
          description: "Type of context to analyze/optimize",
        },
        maxTokens: {
          type: "number",
          minimum: 1000,
          maximum: 100000,
          description: "Maximum tokens to keep after optimization",
        },
        threshold: {
          type: "number",
          minimum: 0.1,
          maximum: 1.0,
          description: "Threshold for cleanup (0.1-1.0)",
        },
      },
      required: ["action", "contextType"],
    },
    execute: async (toolCallId, params, signal, onUpdate) => {
      const action = readStringParam(params, "action");
      const contextType = readStringParam(params, "contextType");
      const maxTokens = readNumberParam(params, "maxTokens") ?? 50000;
      const threshold = readNumberParam(params, "threshold") ?? 0.8;

      if (!action || !contextType) {
        throw new Error("Action and contextType are required");
      }

      logDebug(`Context management: ${action} on ${contextType}`);

      switch (action) {
        case "analyze":
          return jsonResult(await analyzeContext(contextType, config));
        case "optimize":
          return jsonResult(await optimizeContext(contextType, maxTokens, threshold, config));
        case "summarize":
          return await summarizeContext(contextType, config);
        case "compress":
          return await compressContext(contextType, maxTokens, config);
        case "cleanup":
          return await cleanupContext(contextType, threshold, config);
        default:
          throw new Error(`Unknown context action: ${action}`);
      }
    },
  };
}

async function analyzeContext(
  contextType: string,
  config?: OpenClawConfig,
): Promise<ContextAnalysisResult> {
  // Simulate context analysis - in real implementation, this would
  // analyze actual session data, memory stores, etc.
  const mockData = getMockContextData(contextType);
  
  const recommendations: string[] = [];
  if (mockData.totalItems > 1000) {
    recommendations.push("Consider compressing old messages");
  }
  if (mockData.estimatedTokens > 50000) {
    recommendations.push("Context size approaching token limits");
  }
  if (mockData.ageHours > 24) {
    recommendations.push("Consider cleaning up old context");
  }

  return {
    totalItems: mockData.totalItems,
    estimatedTokens: mockData.estimatedTokens,
    oldestItem: mockData.oldestItem,
    newestItem: mockData.newestItem,
    recommendations,
  };
}

async function optimizeContext(
  contextType: string,
  maxTokens: number,
  threshold: number,
  config?: OpenClawConfig,
): Promise<ContextOptimizationResult> {
  const startTime = Date.now();
  const mockData = getMockContextData(contextType);
  
  // Simulate optimization process
  const targetSize = Math.min(mockData.estimatedTokens, maxTokens);
  const compressionRatio = targetSize / mockData.estimatedTokens;
  const optimizedSize = mockData.estimatedTokens * compressionRatio;
  const itemsRemoved = Math.floor(mockData.totalItems * (1 - compressionRatio));
  
  const processingTimeMs = Date.now() - startTime;

  logDebug(`Context optimized: ${mockData.estimatedTokens} -> ${optimizedSize} tokens`);

  return {
    originalSize: mockData.estimatedTokens,
    optimizedSize,
    compressionRatio,
    itemsRemoved,
    processingTimeMs,
  };
}

async function summarizeContext(
  contextType: string,
  config?: OpenClawConfig,
): Promise<any> {
  return jsonResult({
    summary: `Context summary for ${contextType}`,
    keyPoints: [
      "Context contains recent interactions",
      "Main topics discussed",
      "Action items identified",
    ],
    tokenCount: Math.floor(Math.random() * 10000) + 1000,
  });
}

async function compressContext(
  contextType: string,
  maxTokens: number,
  config?: OpenClawConfig,
): Promise<any> {
  return jsonResult({
    compressed: true,
    originalTokens: Math.floor(Math.random() * 50000) + 10000,
    compressedTokens: Math.min(maxTokens, Math.floor(Math.random() * 20000) + 5000),
    method: "lossy_compression",
    retainedInfo: ["key_decisions", "action_items", "critical_context"],
  });
}

async function cleanupContext(
  contextType: string,
  threshold: number,
  config?: OpenClawConfig,
): Promise<any> {
  const mockData = getMockContextData(contextType);
  const itemsToRemove = Math.floor(mockData.totalItems * (1 - threshold));
  
  return jsonResult({
    cleaned: true,
    itemsRemoved: itemsToRemove,
    itemsRemaining: mockData.totalItems - itemsToRemove,
    spaceReclaimed: Math.floor(itemsToRemove * 100), // Mock bytes
    threshold,
  });
}

function getMockContextData(contextType: string) {
  const baseData = {
    totalItems: Math.floor(Math.random() * 2000) + 100,
    estimatedTokens: Math.floor(Math.random() * 80000) + 5000,
    ageHours: Math.floor(Math.random() * 48) + 1,
  };

  const now = new Date();
  return {
    ...baseData,
    oldestItem: new Date(now.getTime() - baseData.ageHours * 60 * 60 * 1000).toISOString(),
    newestItem: now.toISOString(),
  };
}
