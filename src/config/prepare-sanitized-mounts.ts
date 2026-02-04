import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./io.js";
import { resolveConfigPath } from "./paths.js";

/**
 * Generates sanitized versions of config files for secure container mounting.
 * Creates files in ~/.openclaw/.sanitized/ that contain placeholders instead of secrets.
 * Returns the paths to mount into the container.
 */
export interface SanitizedMounts {
  /** Bind mounts in format ["host:container:mode"] */
  binds: string[];
  /** Path to sanitized config directory */
  sanitizedDir: string;
}

/**
 * Pre-sanitize config files on the host for secure container mounting.
 * This is called BEFORE starting the Docker container.
 * 
 * Mount Strategy:
 * - Sanitized auth-profiles.json files mounted read-only (individual files)
 * - Sanitized config file mounted read-only
 * - Conversations directories mounted read-write (need persistence)
 * - Workspace directories mounted read-write (need file access)
 * 
 * NOT Mounted (secrets stay on host):
 * - ~/.openclaw/credentials/ (OAuth tokens - proxy handles refresh)
 * - Original config with real channel tokens
 * - Original auth-profiles.json with real API keys
 */
export async function prepareSanitizedMounts(): Promise<SanitizedMounts> {
  const homeDir = os.homedir();
  const openclawDir = path.join(homeDir, ".openclaw");
  const sanitizedDir = path.join(openclawDir, ".sanitized");
  
  // Clean up any previous sanitized files
  try {
    await fs.promises.rm(sanitizedDir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
  
  // Create sanitized directory
  await fs.promises.mkdir(sanitizedDir, { recursive: true });
  
  const binds: string[] = [];
  
  // =========================================================================
  // 1. SANITIZED CONFIG FILE (read-only)
  // =========================================================================
  const configPath = resolveConfigPath();
  if (configPath && fs.existsSync(configPath)) {
    const originalSecureMode = process.env.OPENCLAW_SECURE_MODE;
    process.env.OPENCLAW_SECURE_MODE = "1";
    
    try {
      // Load config (sanitizeConfigSecrets is applied automatically)
      const config = loadConfig();
      
      // Disable device auth for Control UI in container mode.
      // Docker connections come from 172.17.0.1, not localhost, so
      // auto-pairing for local connections doesn't work.
      // Token auth is still enforced, so this is safe.
      if (!config.gateway) {
        (config as any).gateway = {};
      }
      if (!config.gateway.controlUi) {
        (config.gateway as any).controlUi = {};
      }
      (config.gateway.controlUi as any).dangerouslyDisableDeviceAuth = true;
      
      const ext = path.extname(configPath);
      const sanitizedConfigPath = path.join(sanitizedDir, `openclaw${ext}`);
      
      await fs.promises.writeFile(
        sanitizedConfigPath, 
        JSON.stringify(config, null, 2), 
        "utf8"
      );
      
      // Mount to expected container path (container runs as 'node' user)
      binds.push(`${sanitizedConfigPath}:/home/node/.openclaw/openclaw${ext}:ro`);
    } finally {
      if (originalSecureMode === undefined) {
        delete process.env.OPENCLAW_SECURE_MODE;
      } else {
        process.env.OPENCLAW_SECURE_MODE = originalSecureMode;
      }
    }
  }
  
  // =========================================================================
  // 2. SANITIZED AUTH-PROFILES + REAL CONVERSATIONS (per-agent)
  // =========================================================================
  const agentsDir = path.join(openclawDir, "agents");
  if (fs.existsSync(agentsDir)) {
    const agentIds = await fs.promises.readdir(agentsDir);
    
    for (const agentId of agentIds) {
      const agentAgentDir = path.join(agentsDir, agentId, "agent");
      if (!fs.existsSync(agentAgentDir)) continue;
      
      // Sanitized auth-profiles.json (read-only, mount individual file)
      const authProfilesPath = path.join(agentAgentDir, "auth-profiles.json");
      if (fs.existsSync(authProfilesPath)) {
        const sanitizedAuthPath = path.join(sanitizedDir, "agents", agentId, "agent", "auth-profiles.json");
        await fs.promises.mkdir(path.dirname(sanitizedAuthPath), { recursive: true });
        
        try {
          const authContent = await fs.promises.readFile(authProfilesPath, "utf8");
          const authProfiles = JSON.parse(authContent);
          
          // Sanitize credentials
          const sanitizedProfiles: Record<string, any> = {};
          for (const [profileId, cred] of Object.entries(authProfiles.profiles || {})) {
            const credential = cred as any;
            if (credential.type === "oauth") {
              sanitizedProfiles[profileId] = {
                type: "oauth",
                provider: credential.provider,
                email: credential.email,
                access: `{{OAUTH:${profileId}}}`,
                refresh: `{{OAUTH_REFRESH:${profileId}}}`,
                expires: 0,
              };
            } else if (credential.type === "api_key") {
              sanitizedProfiles[profileId] = {
                type: "api_key",
                provider: credential.provider,
                email: credential.email,
                key: `{{APIKEY:${profileId}}}`,
              };
            } else if (credential.type === "token") {
              sanitizedProfiles[profileId] = {
                type: "token",
                provider: credential.provider,
                email: credential.email,
                token: `{{TOKEN:${profileId}}}`,
              };
            }
          }
          
          const sanitizedAuth = { ...authProfiles, profiles: sanitizedProfiles };
          await fs.promises.writeFile(sanitizedAuthPath, JSON.stringify(sanitizedAuth, null, 2), "utf8");
          
          // Mount sanitized auth file (read-only)
          binds.push(`${sanitizedAuthPath}:/home/node/.openclaw/agents/${agentId}/agent/auth-profiles.json:ro`);
        } catch (err) {
          console.warn(`Skipping auth profiles for agent ${agentId}: ${err}`);
        }
      }
      
      // REAL conversations directory (read-write, no secrets here)
      const conversationsDir = path.join(agentAgentDir, "conversations");
      await fs.promises.mkdir(conversationsDir, { recursive: true });
      binds.push(`${conversationsDir}:/home/node/.openclaw/agents/${agentId}/agent/conversations:rw`);
      
      // NOTE: Sessions directory is NOT mounted because sessions.json contains
      // absolute paths with the host's home directory (skill paths, session file paths).
      // The container will create fresh sessions. This is a trade-off for security.
      // TODO: In future, sanitize sessions.json paths before mounting.
      
      // REAL memory directory (read-write, no secrets here)  
      const memoryDir = path.join(agentAgentDir, "memory");
      await fs.promises.mkdir(memoryDir, { recursive: true });
      binds.push(`${memoryDir}:/home/node/.openclaw/agents/${agentId}/agent/memory:rw`);
    }
  }
  
  // =========================================================================
  // 3. WORKSPACE DIRECTORIES (read-write)
  // =========================================================================
  const workspaceDir = path.join(openclawDir, "workspace");
  await fs.promises.mkdir(workspaceDir, { recursive: true });
  binds.push(`${workspaceDir}:/home/node/.openclaw/workspace:rw`);
  
  // Per-agent workspaces (workspace-{agentId})
  try {
    const entries = await fs.promises.readdir(openclawDir);
    for (const entry of entries) {
      if (entry.startsWith("workspace-")) {
        const wsPath = path.join(openclawDir, entry);
        const stat = await fs.promises.stat(wsPath);
        if (stat.isDirectory()) {
          binds.push(`${wsPath}:/home/node/.openclaw/${entry}:rw`);
        }
      }
    }
  } catch {
    // Ignore
  }
  
  // =========================================================================
  // 4. CONTROL UI (canvas) - read-only
  // =========================================================================
  const canvasDir = path.join(openclawDir, "canvas");
  if (fs.existsSync(canvasDir)) {
    binds.push(`${canvasDir}:/home/node/.openclaw/canvas:ro`);
  }
  
  // =========================================================================
  // 5. DEVICES DIRECTORY (read-write) - for device pairing
  // =========================================================================
  const devicesDir = path.join(openclawDir, "devices");
  await fs.promises.mkdir(devicesDir, { recursive: true });
  binds.push(`${devicesDir}:/home/node/.openclaw/devices:rw`);
  
  // =========================================================================
  // 6. CRON DIRECTORY (read-write) - for scheduled tasks
  // =========================================================================
  const cronDir = path.join(openclawDir, "cron");
  await fs.promises.mkdir(cronDir, { recursive: true });
  binds.push(`${cronDir}:/home/node/.openclaw/cron:rw`);
  
  // =========================================================================
  // 4. DO NOT MOUNT CREDENTIALS (stay on host only)
  // =========================================================================
  // ~/.openclaw/credentials/ contains real OAuth tokens
  // The proxy handles OAuth refresh on the host side
  
  return { binds, sanitizedDir };
}

/**
 * Clean up sanitized files after container stops.
 */
export async function cleanupSanitizedMounts(sanitizedDir: string): Promise<void> {
  try {
    await fs.promises.rm(sanitizedDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
