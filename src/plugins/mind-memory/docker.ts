import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ensureDockerDaemon, getDockerStatus } from "../../infra/docker.js";

const execAsync = promisify(exec);

/**
 * CLI Command: Attempts to install Docker on the current platform.
 */
export async function installDocker(): Promise<boolean> {
  const { installed } = await getDockerStatus();
  if (installed) {
    process.stderr.write("🐳 [DOCKER] Docker is already installed.\n");
    return true;
  }

  // Automatic installation often hangs due to sudo prompts or invisible inputs.
  // Fall back immediately to manual installation instructions.
  process.stderr.write("❌ [DOCKER] Docker not found.\n");
  return false;
}

/**
 * Background Service: Ensures the Docker daemon is running and the Graphiti container is up.
 */
export async function ensureGraphitiDocker(pluginDir: string): Promise<boolean> {
  try {
    // 1. Ensure Daemon is running
    const ok = await ensureDockerDaemon({
      onLog: (msg) => process.stderr.write(msg + "\n"),
    });
    if (!ok) {
      return false;
    }

    // 2. Check if container is already running
    const { stdout } = await execAsync('docker ps --filter "name=graphiti" --format "{{.Names}}"');
    if (stdout.includes("graphiti")) {
      process.stderr.write("🐳 [DOCKER] Graphiti container is already running.\n");
      return true;
    }

    // 3. Search for docker-compose.yml
    process.stderr.write("🐳 [DOCKER] Graphiti not found. Searching for docker-compose.yml...\n");
    const candidates = [
      path.join(pluginDir, "docker-compose.yml"),
      path.resolve(pluginDir, "../../../extensions/mind-memory/docker-compose.yml"),
      path.resolve(pluginDir, "../../../docker-compose.yml"),
      path.resolve(pluginDir, "../../extensions/mind-memory/docker-compose.yml"),
      path.resolve(pluginDir, "../../docker-compose.yml"),
    ];

    let composePath: string | null = null;
    for (const p of candidates) {
      try {
        await fs.access(p);
        composePath = p;
        process.stderr.write(`🐳 [DOCKER] Found compose file at: ${p}\n`);
        break;
      } catch {
        // Ignore
      }
    }

    if (!composePath) {
      process.stderr.write(`❌ [DOCKER] No docker-compose.yml found.\n`);
      return false;
    }

    process.stderr.write(
      `🐳 [DOCKER] Starting Graphiti via: docker compose -f ${composePath} up -d\n`,
    );
    await execAsync(`docker compose -f ${composePath} up -d`);
    process.stderr.write("✅ [DOCKER] Graphiti started successfully.\n");
    return true;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`❌ [DOCKER] Error: ${message}\n`);
    return false;
  }
}
