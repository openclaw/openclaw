import { spawn, ChildProcess } from 'child_process'
import { mkdirSync, createWriteStream } from 'fs'
import { join, dirname } from 'path'

export interface AgentProcessConfig {
  teamName: string
  memberName: string
  role: string
  notifyPort: number
  configPath: string
}

/**
 * Spawns a headless OpenClaw worker process for agent team coordination.
 *
 * The worker process inherits the caller's environment (API keys, model
 * config, auth) and receives team context via environment variables.
 *
 * Used by the openclaw-teams plugin. Designed as a generic hook so other
 * plugins can also spawn isolated agent processes.
 *
 * Environment variables passed to the worker:
 *   OPENCLAW_TEAM_NAME      - team identifier
 *   OPENCLAW_MEMBER_NAME    - member/worker identifier
 *   OPENCLAW_ROLE           - member role (e.g. "researcher", "writer")
 *   OPENCLAW_CONFIG_PATH    - path to team config.json
 *   OPENCLAW_NOTIFY_PORT    - local HTTP port for receiving notifications
 */
export function spawnAgentProcess(config: AgentProcessConfig): ChildProcess {
  const logDir = join(dirname(config.configPath), 'logs')
  mkdirSync(logDir, { recursive: true })

  const child = spawn('openclaw', ['--mode=worker'], {
    env: {
      ...process.env,
      OPENCLAW_TEAM_NAME: config.teamName,
      OPENCLAW_MEMBER_NAME: config.memberName,
      OPENCLAW_ROLE: config.role,
      OPENCLAW_CONFIG_PATH: config.configPath,
      OPENCLAW_NOTIFY_PORT: String(config.notifyPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })

  child.stdout?.pipe(
    createWriteStream(join(logDir, `${config.memberName}.log`), { flags: 'a' })
  )
  child.stderr?.pipe(
    createWriteStream(join(logDir, `${config.memberName}.err`), { flags: 'a' })
  )

  return child
}
