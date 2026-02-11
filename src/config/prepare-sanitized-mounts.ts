import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveConfigPath } from "./paths.js";
import { sanitizeConfigSecrets } from "./sanitize-secrets.js";

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
    try {
      // Load config from the exact resolved path so sanitization matches the mounted file
      const { loadConfig: loadResolvedConfig } = await import("./io.js").then((m) =>
        m.createConfigIO({ configPath }),
      );
      const rawConfig = loadResolvedConfig();
      const config = sanitizeConfigSecrets(rawConfig, { force: true });

      const ext = path.extname(configPath);
      const sanitizedConfigPath = path.join(sanitizedDir, `openclaw${ext}`);

      await fs.promises.writeFile(sanitizedConfigPath, JSON.stringify(config, null, 2), "utf8");

      // Mount to expected container path (container runs as 'node' user)
      binds.push(`${sanitizedConfigPath}:/home/node/.openclaw/openclaw${ext}:ro`);
    } catch (err) {
      throw new Error(`Failed to sanitize config: ${String(err)}`, { cause: err });
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
      if (!fs.existsSync(agentAgentDir)) {
        continue;
      }

      // Sanitized auth-profiles.json (read-only, mount individual file)
      const authProfilesPath = path.join(agentAgentDir, "auth-profiles.json");
      if (fs.existsSync(authProfilesPath)) {
        const sanitizedAuthPath = path.join(
          sanitizedDir,
          "agents",
          agentId,
          "agent",
          "auth-profiles.json",
        );
        await fs.promises.mkdir(path.dirname(sanitizedAuthPath), { recursive: true });

        try {
          const authContent = await fs.promises.readFile(authProfilesPath, "utf8");
          const authProfiles = JSON.parse(authContent);

          // Sanitize credentials
          const sanitizedProfiles: Record<string, unknown> = {};
          for (const [profileId, cred] of Object.entries(authProfiles.profiles || {})) {
            const credential = cred as Record<string, unknown>;
            if (credential.type === "oauth") {
              sanitizedProfiles[profileId] = {
                type: "oauth",
                provider: credential.provider,
                email: credential.email,
                // projectId is not a secret - preserve it for google-gemini-cli
                projectId: credential.projectId,
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
          await fs.promises.writeFile(
            sanitizedAuthPath,
            JSON.stringify(sanitizedAuth, null, 2),
            "utf8",
          );

          // Mount sanitized auth file (read-only - OAuth refresh happens on host proxy)
          binds.push(
            `${sanitizedAuthPath}:/home/node/.openclaw/agents/${agentId}/agent/auth-profiles.json:ro`,
          );
        } catch (err) {
          console.warn(`Skipping auth profiles for agent ${agentId}: ${String(err)}`);
        }
      }

      // REAL conversations directory (read-write, no secrets here)
      const conversationsDir = path.join(agentAgentDir, "conversations");
      await fs.promises.mkdir(conversationsDir, { recursive: true });
      binds.push(
        `${conversationsDir}:/home/node/.openclaw/agents/${agentId}/agent/conversations:rw`,
      );

      // REAL memory directory (read-write, no secrets here)
      const memoryDir = path.join(agentAgentDir, "memory");
      await fs.promises.mkdir(memoryDir, { recursive: true });
      binds.push(`${memoryDir}:/home/node/.openclaw/agents/${agentId}/agent/memory:rw`);

      // Sessions directory - note: this is at /agents/{id}/sessions, NOT /agents/{id}/agent/sessions
      // Use a separate sessions-secure directory to avoid sessions.json with host paths
      const agentDir = path.join(agentsDir, agentId);
      const sessionsSecureDir = path.join(agentDir, "sessions-secure");
      await fs.promises.mkdir(sessionsSecureDir, { recursive: true });
      binds.push(`${sessionsSecureDir}:/home/node/.openclaw/agents/${agentId}/sessions:rw`);
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
  // 7. CREDENTIALS DIRECTORY - mount only safe files, exclude oauth.json
  // =========================================================================
  // Safe to mount (NOT secrets):
  // - telegram-pairing.json, telegram-allowFrom.json (channel pairing metadata)
  // - lid-mapping-*.json (WhatsApp LID-to-phone lookups)
  // NOT safe to mount:
  // - oauth.json (legacy file that may contain real OAuth tokens)
  // OAuth tokens are stored in per-agent auth-profiles.json (sanitized separately).
  const credentialsDir = path.join(openclawDir, "credentials");
  if (fs.existsSync(credentialsDir)) {
    try {
      const entries = await fs.promises.readdir(credentialsDir);
      for (const entry of entries) {
        // Skip oauth.json - may contain real secrets from legacy installs
        if (entry === "oauth.json") {
          continue;
        }
        const srcPath = path.join(credentialsDir, entry);
        const stat = await fs.promises.stat(srcPath);
        if (stat.isFile()) {
          binds.push(`${srcPath}:/home/node/.openclaw/credentials/${entry}:ro`);
        }
      }
    } catch (err) {
      console.warn(`Failed to enumerate credentials directory: ${String(err)}`);
    }
  }

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
