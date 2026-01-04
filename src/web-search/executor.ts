/**
 * Web Search CLI Executor
 */

import type { WebSearchResult } from './messages.js';
import type { ExecuteResult, ExecuteOptions } from '../deep-research/executor.js';
import { executeGeminiSearch } from './gemini-cli.js';
import { loadConfig, getDefaultWebSearchCliPath } from '../config/config.js';

export interface ExecuteWebSearchOptions extends Omit<ExecuteOptions, 'topic'> {
  cliPath?: string;
  timeoutMs?: number;
}

export interface ExecuteWebSearchResult extends Omit<ExecuteResult, 'resultJsonPath'> {
  result?: WebSearchResult;
}

/**
 * Execute web search via Gemini CLI
 */
export async function executeWebSearch(
  query: string,
  options: ExecuteWebSearchOptions = {}
): Promise<ExecuteWebSearchResult> {
  const cfg = loadConfig();
  const {
    cliPath = cfg.webSearch?.cliPath ?? getDefaultWebSearchCliPath(),
    timeoutMs = cfg.webSearch?.timeoutMs ?? 30000,
    dryRun = false,
  } = options;
  
  if (dryRun) {
    return {
      success: true,
      runId: `dry-run-${Date.now()}`,
      result: {
        response: "DRY RUN: Would search for: " + query,
        session_id: `dry-run-${Date.now()}`,
        stats: {
          models: {
            "gemini-1.5": {
              api: { totalRequests: 0, totalErrors: 0 },
              tokens: { input: 0, candidates: 0, total: 0 }
            }
          }
        }
      },
      stdout: "",
      stderr: ""
    };
  }
  
  try {
    // Simple query validation
    if (!query || query.length < 2) {
      throw new Error("Query too short or empty");
    }
    
    if (query.length > 200) {
      throw new Error("Query too long (max 200 characters)");
    }
    
    // Use the standalone gemini CLI module
    const result = await executeGeminiSearch(query, { timeoutMs, cliPath });
    
    return {
      success: true,
      runId: result.session_id,
      result,
      stdout: JSON.stringify(result),
      stderr: ""
    };
    
  } catch (error) {
    // Simple error handling
    const errorStr = String(error);
    
    let errorMessage = `Search failed: ${errorStr}`;
    
    // Make error messages more user-friendly
    if (errorStr.includes('timeout')) {
      errorMessage = '⏱️ Поиск занял слишком много времени';
    } else if (errorStr.includes('not found')) {
      errorMessage = '❌ Gemini CLI не найден. Проверьте установку.';
    } else if (errorStr.includes('too short')) {
      errorMessage = '❌ Запрос слишком короткий';
    } else if (errorStr.includes('too long')) {
      errorMessage = '❌ Запрос слишком длинный (макс. 200 символов)';
    }
    
    return {
      success: false,
      runId: `error-${Date.now()}`,
      error: errorMessage,
      stdout: "",
      stderr: errorStr
    };
  }
}