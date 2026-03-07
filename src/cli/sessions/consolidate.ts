#!/usr/bin/env node

/**
 * Session Consolidation CLI
 *
 * Consolidate multiple sessions for a chat_id into one unified session.
 *
 * Usage:
 *   openclaw sessions consolidate --chat-id <chat_id>
 *   openclaw sessions consolidate --chat-id <chat_id> --output <path>
 */

import fs from "node:fs";
import path from "node:path";
import { program } from "commander";
import {
  findSessionsForChatId,
  registerSessionMapping,
  loadSessionIndex,
} from "../../config/sessions/session-index.js";

interface ConsolidateOptions {
  chatId: string;
  output?: string;
}

export async function consolidateSessions(
  chatId: string,
  outputDir?: string,
): Promise<void> {
  const sessionsDir = path.join(
    process.env.HOME || '',
    '.openclaw/agents/main/sessions'
  );
  
  // Find all sessions for this chat_id
  const sessionFiles = findSessionsForChatId(chatId, sessionsDir);
  
  if (sessionFiles.length === 0) {
    console.log(`❌ No sessions found for chat_id: ${chatId}`);
    return;
  }
  
  if (sessionFiles.length === 1) {
    console.log(`ℹ️ Only 1 session found, no consolidation needed`);
    console.log(`   Session: ${sessionFiles[0]}`);
    return;
  }
  
  console.log(`🔀 Consolidating ${sessionFiles.length} sessions for ${chatId}...`);
  
  // Sort by modification time (oldest first)
  sessionFiles.sort((a, b) => {
    const statA = fs.statSync(path.join(sessionsDir, a));
    const statB = fs.statSync(path.join(sessionsDir, b));
    return statA.mtimeMs - statB.mtimeMs;
  });
  
  // Create unified session
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T').join('_');
  const unifiedId = `unified_${chatId.replace(/:/g, '_')}_${timestamp}`;
  const unifiedPath = path.join(
    outputDir || sessionsDir,
    `${unifiedId}.jsonl`
  );
  
  let messagesWritten = 0;
  const output = fs.createWriteStream(unifiedPath, { encoding: 'utf-8' });
  
  try {
    // Write session header
    const header = {
      type: 'session',
      version: 3,
      id: unifiedId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
      consolidated_from: sessionFiles,
      chat_id: chatId,
    };
    output.write(JSON.stringify(header) + '\n');
    messagesWritten++;
    
    // Append messages from each session
    for (const file of sessionFiles) {
      console.log(`   📄 Merging ${file}...`);
      const filePath = path.join(sessionsDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      
      for (let i = 1; i < lines.length; i++) { // Skip header
        if (lines[i].trim()) {
          try {
            const data = JSON.parse(lines[i]);
            // Add consolidation marker
            if (data.type === 'message' && !data.consolidated_from) {
              data.consolidated_from = file.replace('.jsonl', '');
            }
            output.write(JSON.stringify(data) + '\n');
          } catch {
            // Write raw line if not valid JSON
            output.write(lines[i] + '\n');
          }
          messagesWritten++;
        }
      }
    }
    
    output.end();
    
    // Wait for stream to finish
    await new Promise((resolve, reject) => {
      output.on('finish', resolve);
      output.on('error', reject);
    });
    
    console.log(`✅ Created unified session: ${unifiedId} (${messagesWritten} entries)`);
    
    // Update index
    registerSessionMapping(chatId, unifiedId);
    console.log(`📝 Session index updated`);
    
  } catch (error) {
    output.end();
    console.error(`❌ Error consolidating sessions:`, error);
    throw error;
  }
}

export function createConsolidateCommand(program: any): void {
  program
    .command('consolidate')
    .description('Consolidate multiple sessions for a chat_id into one')
    .requiredOption('--chat-id <chat_id>', 'Chat ID to consolidate')
    .option('--output <path>', 'Output directory for unified session')
    .action(async (opts: ConsolidateOptions) => {
      try {
        await consolidateSessions(opts.chatId, opts.output);
      } catch (error) {
        console.error('Consolidation failed:', error);
        process.exit(1);
      }
    });
}
