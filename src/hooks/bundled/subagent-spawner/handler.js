/**
 * Subagent Spawner Hook
 *
 * Purpose: Spawn channel agents automatically on gateway startup
 * Triggered by: gateway:startup event
 */

const { spawn } = require('child_process');
const fs = require('fs');

const AGENTS_TO_SPAWN = [
  { label: 'telegram-agent', purpose: 'Telegram message handler' },
  { label: 'discord-agent', purpose: 'Discord presence handler' }
];

/**
 * Check if an agent is running by checking sessions
 */
async function isAgentRunning(label) {
  try {
    const sessions = await new Promise((resolve, reject) => {
        const proc = spawn('openclaw', ['sessions', 'list', '--json'], {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';

        proc.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        proc.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`openclaw sessions list failed with code ${code}`));
            return;
          }
          resolve(stdout);
        });
      });

    const sessionsData = JSON.parse(sessions);
    // Handle both formats: { sessions: [...] } or direct array [...]
    const sessions = Array.isArray(sessionsData) ? sessionsData : (sessionsData?.sessions || []);
    if (!Array.isArray(sessions)) {
      return false;
    }
    return sessions.some(s => s.label === label && s.active);
  } catch (error) {
    console.log(`[subagent-spawner] Error checking ${label}: ${error.message}`);
    return false;
  }
}

/**
 * Spawn a subagent with specific task
 */
async function spawnAgent(label, purpose) {
  console.log(`[subagent-spawner] Spawning ${label}...`);

  const spawnProcess = spawn('openclaw', [
    'sessions', 'spawn',
    '--task', `You are the ${label}. Purpose: ${purpose}.\n\nHandle your channel's messages directly. Be concise, task-focused. No personality - just do the job.`,
    '--label', label,
    '--cleanup', 'keep'  // Keep session alive
  ], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  spawnProcess.stdout.on('data', (data) => {
    console.log(`[subagent-spawner] ${label}: ${data.toString().trim()}`);
  });

  spawnProcess.stderr.on('data', (data) => {
    console.error(`[subagent-spawner] ${label} error: ${data.toString().trim()}`);
  });

  spawnProcess.on('close', (code) => {
    if (code === 0) {
      console.log(`[subagent-spawner] ${label} spawned successfully`);
    } else {
      console.error(`[subagent-spawner] ${label} failed to spawn (code ${code})`);
    }
  });

  // Detach so it continues running
  spawnProcess.unref();
}

/**
 * Main hook handler for gateway:startup event
 */
async function onGatewayStartup() {
  console.log('[subagent-spawner] Gateway startup detected');
  console.log('[subagent-spawner] Checking subagent status...');

  for (const agent of AGENTS_TO_SPAWN) {
    const isRunning = await isAgentRunning(agent.label);

    if (isRunning) {
      console.log(`[subagent-spawner] ${agent.label} already running`);
      continue;
    }

    console.log(`[subagent-spawner] ${agent.label} not running, spawning...`);
    await spawnAgent(agent.label, agent.purpose);
  }

  console.log('[subagent-spawner] All channel agents ready');
}

// Export for OpenClaw hook system
module.exports = {
  onGatewayStartup
};
