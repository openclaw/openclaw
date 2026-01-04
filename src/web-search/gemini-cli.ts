/**
 * Standalone Gemini CLI wrapper
 * Simplified implementation - directly calls gemini CLI without external bash wrapper
 */

import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import type { WebSearchResult } from './messages.js';

const exec = promisify(execCallback);

export interface GeminiCliOptions {
  timeoutMs?: number;
  model?: string;
  cliPath?: string;
}

/**
 * Execute search directly via gemini CLI - simplified implementation using shell
 */
export async function executeGeminiSearch(
  query: string,
  options: GeminiCliOptions = {}
): Promise<WebSearchResult> {
  const {
    timeoutMs = 30000,
    model = 'gemini-2.5-flash',
    cliPath,
  } = options;

  try {
    // Build prompt
    const prompt = `Search web for: ${query}. Answer in Russian with current information.`;

    // Use cliPath if provided (bash wrapper script), otherwise use gemini directly
    let cmd: string;
    if (cliPath) {
      // Use the bash wrapper script with --request parameter
      cmd = `sh -c ${JSON.stringify(`"${cliPath}" --request ${JSON.stringify(query)}`)}`;
    } else {
      // Direct gemini CLI call
      cmd = `sh -c ${JSON.stringify(`gemini -m ${model} -p ${JSON.stringify(prompt)} --output-format json`)}`
    }
    
    const { stdout } = await exec(cmd, {
      timeout: timeoutMs,
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH }
    });
    
    if (!stdout.trim()) {
      throw new Error('Empty response from Gemini CLI');
    }
    
    // Parse result
    const result = JSON.parse(stdout.trim());
    
    if (!result.response) {
      throw new Error('No response field in Gemini output');
    }
    
    return {
      response: result.response,
      session_id: result.session_id || `gemini-${Date.now()}`,
      stats: result.stats || {
        models: {
          [model]: {
            api: { totalRequests: 1, totalErrors: 0 },
            tokens: { input: 0, candidates: 0, total: 0 }
          }
        }
      }
    };
    
  } catch (error) {
    // If it's a JSON parse error, include more info
    if (error instanceof SyntaxError) {
      const stdout = (error as any).stdout || '';
      throw new Error(`Failed to parse Gemini response (length: ${stdout.length}). Error: ${error.message}. Raw: ${stdout.substring(0, 200)}`);
    }
    
    throw error;
  }
}

/**
 * Check if gemini CLI is available
 */
export async function isGeminiCliAvailable(): Promise<boolean> {
  try {
    await exec('which gemini', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get gemini version
 */
export async function getGeminiVersion(): Promise<string | null> {
  try {
    const { stdout } = await exec('gemini --version', { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}
