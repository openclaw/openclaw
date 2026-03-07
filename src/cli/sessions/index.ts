#!/usr/bin/env node

/**
 * Session Index CLI
 *
 * Manage session index (rebuild, list, etc.)
 *
 * Usage:
 *   openclaw sessions index --rebuild
 *   openclaw sessions index --list
 */

import path from "node:path";
import {
  rebuildIndex,
  loadSessionIndex,
} from "../../config/sessions/session-index.js";

interface IndexOptions {
  rebuild?: boolean;
  list?: boolean;
  output?: string;
}

export async function rebuildSessionIndex(
  output?: string,
): Promise<void> {
  const sessionsDir = path.join(
    process.env.HOME || '',
    '.openclaw/agents/main/sessions'
  );
  
  const indexPath = output || path.resolve('./session_index.json');
  
  console.log(`🔨 Rebuilding session index...`);
  console.log(`   Sessions directory: ${sessionsDir}`);
  console.log(`   Index path: ${indexPath}`);
  
  const index = rebuildIndex(sessionsDir, indexPath);
  
  console.log(`✅ Index rebuilt: ${index.total_sessions} chat_id mappings`);
  console.log(`\n📊 Summary:`);
  
  for (const [chatId, sessionId] of Object.entries(index.mappings)) {
    console.log(`   ${chatId} → ${sessionId}`);
  }
}

export async function listSessionIndex(
  output?: string,
): Promise<void> {
  const indexPath = output || path.resolve('./session_index.json');
  const index = loadSessionIndex(indexPath);
  
  console.log(`📋 Session Index (${index.total_sessions} mappings):`);
  console.log(`   Created: ${index.created_at}`);
  if (index.last_rebuilt) {
    console.log(`   Last rebuilt: ${index.last_rebuilt}`);
  }
  if (index.last_updated) {
    console.log(`   Last updated: ${index.last_updated}`);
  }
  console.log(``);
  
  for (const [chatId, sessionId] of Object.entries(index.mappings)) {
    console.log(`   ${chatId} → ${sessionId}`);
  }
}

export function createIndexCommand(program: any): void {
  program
    .command('index')
    .description('Manage session index')
    .option('--rebuild', 'Rebuild index from scratch')
    .option('--list', 'List all mappings')
    .option('--output <path>', 'Output path for index file')
    .action(async (opts: IndexOptions) => {
      try {
        if (opts.rebuild) {
          await rebuildSessionIndex(opts.output);
        } else if (opts.list) {
          await listSessionIndex(opts.output);
        } else {
          // Default: show status
          const indexPath = opts.output || path.resolve('./session_index.json');
          const index = loadSessionIndex(indexPath);
          console.log(`📊 Session Index Status:`);
          console.log(`   Total mappings: ${index.total_sessions}`);
          console.log(`   Created: ${index.created_at}`);
          console.log(`   Last updated: ${index.last_updated || 'never'}`);
        }
      } catch (error) {
        console.error('Index operation failed:', error);
        process.exit(1);
      }
    });
}
