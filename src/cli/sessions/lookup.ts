#!/usr/bin/env node

/**
 * Session Lookup CLI
 *
 * Lookup session by chat_id using the session index.
 *
 * Usage:
 *   openclaw sessions lookup --chat-id <chat_id>
 */

import path from "node:path";
import {
  lookupSessionByChatId,
  loadSessionIndex,
  scanSessionsForChatId,
} from "../../config/sessions/session-index.js";
import { loadCombinedSessionStoreForGateway } from "../config/sessions/store.js";
import type { OpenClawConfig } from "../config/types.js";

interface LookupOptions {
  chatId: string;
  json?: boolean;
}

export async function lookupSession(
  chatId: string,
  cfg?: OpenClawConfig,
): Promise<any> {
  // Try index first
  const sessionId = lookupSessionByChatId(chatId);
  
  if (sessionId) {
    return {
      found: true,
      source: 'index',
      chat_id: chatId,
      session_id: sessionId,
    };
  }
  
  // Fallback: scan sessions
  const sessionsDir = path.join(
    process.env.HOME || '',
    '.openclaw/agents/main/sessions'
  );
  
  const scannedSessionId = scanSessionsForChatId(chatId, sessionsDir);
  
  if (scannedSessionId) {
    // Register in index for future lookups
    const indexPath = path.resolve('./session_index.json');
    const index = loadSessionIndex(indexPath);
    index.mappings[chatId] = scannedSessionId;
    
    import("../config/sessions/session-index.js").then(({ saveSessionIndex }) => {
      saveSessionIndex(indexPath, index);
    });
    
    return {
      found: true,
      source: 'scan',
      chat_id: chatId,
      session_id: scannedSessionId,
      index_updated: true,
    };
  }
  
  return {
    found: false,
    chat_id: chatId,
    message: 'No session found for this chat_id',
  };
}

export function createLookupCommand(program: any): void {
  program
    .command('lookup')
    .description('Lookup session by chat_id')
    .requiredOption('--chat-id <chat_id>', 'Chat ID to lookup')
    .option('--json', 'Output as JSON')
    .action(async (opts: LookupOptions) => {
      try {
        const result = await lookupSession(opts.chatId);
        
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (result.found) {
            console.log(`✅ Found session for ${opts.chatId}:`);
            console.log(`   Session ID: ${result.session_id}`);
            console.log(`   Source: ${result.source}`);
            if (result.index_updated) {
              console.log(`   ℹ️ Session index updated`);
            }
          } else {
            console.log(`❌ No session found for ${opts.chatId}`);
          }
        }
      } catch (error) {
        console.error('Lookup failed:', error);
        process.exit(1);
      }
    });
}
