import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execDocker, execDockerRaw, dockerContainerState } from "../agents/sandbox/docker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("docker:mongodb");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Docker Detection
// ---------------------------------------------------------------------------

/**
 * Check if Docker CLI is installed.
 * Does NOT check if daemon is running.
 */
export async function isDockerInstalled(): Promise<boolean> {
  try {
    await execDocker(["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Docker daemon is running.
 * Assumes Docker CLI is installed.
 */
export async function isDockerDaemonRunning(): Promise<boolean> {
  try {
    await execDocker(["info"], { allowFailure: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Docker Compose is available and which version.
 * Returns "v2" for `docker compose` (plugin) or false if not available.
 */
export async function isDockerComposeAvailable(): Promise<"v2" | false> {
  try {
    await execDocker(["compose", "version"]);
    return "v2";
  } catch {
    return false;
  }
}

export type DockerStatus = {
  installed: boolean;
  daemonRunning: boolean;
  composeAvailable: "v2" | false;
};

/**
 * Full Docker environment check. All three steps: CLI, daemon, compose.
 */
export async function checkDockerEnvironment(): Promise<DockerStatus> {
  const installed = await isDockerInstalled();
  if (!installed) {
    return { installed: false, daemonRunning: false, composeAvailable: false };
  }
  const daemonRunning = await isDockerDaemonRunning();
  if (!daemonRunning) {
    return { installed: true, daemonRunning: false, composeAvailable: false };
  }
  const composeAvailable = await isDockerComposeAvailable();
  return { installed: true, daemonRunning: true, composeAvailable };
}

// ---------------------------------------------------------------------------
// Existing MongoDB Detection
// ---------------------------------------------------------------------------

export type ExistingMongoDBResult = {
  connected: boolean;
  uri?: string;
  isDocker?: boolean;
};

/**
 * Try to connect to MongoDB at localhost:27017 to detect existing instances.
 * Uses 5-second timeout. Returns connected=true if MongoDB is already running.
 * This should be called BEFORE attempting Docker auto-start.
 */
export async function detectExistingMongoDB(port = 27017): Promise<ExistingMongoDBResult> {
  const uri = `mongodb://localhost:${port}/openclaw`;
  try {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
    });
    try {
      await client.connect();
      await client.db().admin().command({ ping: 1 });

      // Check if it's running in Docker
      let isDocker = false;
      try {
        const state = await dockerContainerState("clawmongo-mongod");
        isDocker = state.running;
      } catch {
        // Not a Docker container or Docker not available
      }
      if (!isDocker) {
        try {
          const state = await dockerContainerState("clawmongo-mongod-standalone");
          isDocker = state.running;
        } catch {
          // Not a Docker container
        }
      }

      return { connected: true, uri, isDocker };
    } finally {
      await client.close().catch(() => {});
    }
  } catch {
    return { connected: false };
  }
}

// ---------------------------------------------------------------------------
// Port Conflict Detection
// ---------------------------------------------------------------------------

/**
 * Check if a port is in use on localhost.
 * Uses net.createServer to probe - fast and reliable.
 */
export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port, "127.0.0.1");
  });
}

// ---------------------------------------------------------------------------
// Docker Compose Orchestration
// ---------------------------------------------------------------------------

/**
 * Get absolute path to docker-compose.mongodb.yml.
 * Resolves relative to the package root (../../docker/mongodb/...).
 */
export function getComposeFilePath(): string {
  // src/docker/mongodb-docker.ts -> ../../docker/mongodb/docker-compose.mongodb.yml
  return path.resolve(__dirname, "..", "..", "docker", "mongodb", "docker-compose.mongodb.yml");
}

export type ComposeTier = "standalone" | "replicaset" | "fullstack";

/**
 * Run the setup-generator (keyfile + auth files).
 * Required before replicaset or fullstack profiles.
 */
export async function runSetupGenerator(composeFile: string): Promise<void> {
  log.info("Running setup-generator for auth files...");
  await execDocker(
    ["compose", "-f", composeFile, "--profile", "setup", "run", "--rm", "setup-generator"],
    { allowFailure: false },
  );
}

/**
 * Start MongoDB via docker-compose with the specified profile.
 * Automatically runs setup-generator first for replicaset/fullstack.
 */
export async function startMongoDBCompose(composeFile: string, tier: ComposeTier): Promise<void> {
  // Setup generator needed for replicaset and fullstack (auth files)
  if (tier !== "standalone") {
    await runSetupGenerator(composeFile);
  }

  log.info(`Starting MongoDB with profile: ${tier}`);
  await execDocker(["compose", "-f", composeFile, "--profile", tier, "up", "-d"], {
    allowFailure: false,
  });
}

/**
 * Stop all MongoDB Compose services.
 */
export async function stopMongoDBCompose(composeFile: string): Promise<void> {
  log.info("Stopping all MongoDB Compose services...");
  await execDocker(
    [
      "compose",
      "-f",
      composeFile,
      "--profile",
      "standalone",
      "--profile",
      "replicaset",
      "--profile",
      "fullstack",
      "down",
    ],
    { allowFailure: true },
  );
}

/**
 * Wait for a Docker container to report healthy status.
 * Polls `docker inspect --format '{{.State.Health.Status}}'` until healthy or timeout.
 */
export async function waitForMongoDBHealth(
  containerName: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const result = await execDocker(
        ["inspect", "--format", "{{.State.Health.Status}}", containerName],
        { allowFailure: true },
      );
      const status = result.stdout.trim();
      if (status === "healthy") {
        return true;
      }
      if (status === "unhealthy") {
        log.warn(`Container ${containerName} is unhealthy`);
        return false;
      }
    } catch {
      // Container may not exist yet
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  log.warn(`Timeout waiting for ${containerName} health check (${timeoutMs}ms)`);
  return false;
}

// ---------------------------------------------------------------------------
// Auto-Start with Fallback Tiers
// ---------------------------------------------------------------------------

export type AutoStartResult = {
  success: boolean;
  tier?: ComposeTier;
  uri?: string;
  error?: string;
};

const TIER_CONTAINERS: Record<ComposeTier, string[]> = {
  fullstack: ["clawmongo-mongod", "clawmongo-mongot"],
  replicaset: ["clawmongo-mongod"],
  standalone: ["clawmongo-mongod-standalone"],
};

const TIER_URIS: Record<ComposeTier, string> = {
  fullstack: "mongodb://admin:admin@localhost:27017/?authSource=admin&replicaSet=rs0",
  replicaset: "mongodb://admin:admin@localhost:27017/?authSource=admin&replicaSet=rs0",
  standalone: "mongodb://localhost:27017/openclaw",
};

const FALLBACK_ORDER: ComposeTier[] = ["fullstack", "replicaset", "standalone"];

/**
 * Auto-start MongoDB with fallback tiers: fullstack -> replicaset -> standalone.
 * Reports progress via onProgress callback.
 * Returns the tier that succeeded, or success=false if all fail.
 */
export async function autoStartMongoDB(options: {
  composeFile: string;
  onProgress?: (message: string) => void;
  healthTimeoutMs?: number;
  healthPollIntervalMs?: number;
}): Promise<AutoStartResult> {
  const {
    composeFile,
    onProgress,
    healthTimeoutMs = 120_000,
    healthPollIntervalMs = 2_000,
  } = options;
  const report = onProgress ?? (() => {});

  for (const tier of FALLBACK_ORDER) {
    try {
      report(`Starting MongoDB (${tier})...`);

      // Stop any previously running services before trying next tier
      await stopMongoDBCompose(composeFile).catch(() => {});

      await startMongoDBCompose(composeFile, tier);

      // Wait for primary container to be healthy
      const primaryContainer = TIER_CONTAINERS[tier][0];
      report(`Waiting for ${primaryContainer} to be ready...`);
      const healthy = await waitForMongoDBHealth(primaryContainer, {
        timeoutMs: healthTimeoutMs,
        pollIntervalMs: healthPollIntervalMs,
      });

      if (!healthy) {
        log.warn(`${tier}: primary container did not become healthy`);
        continue;
      }

      // For fullstack, also wait for mongot
      if (tier === "fullstack") {
        report("Waiting for mongot search engine...");
        const mongotHealthy = await waitForMongoDBHealth("clawmongo-mongot", {
          timeoutMs: healthTimeoutMs,
          pollIntervalMs: healthPollIntervalMs,
        });
        if (!mongotHealthy) {
          log.warn("fullstack: mongot did not become healthy, falling back");
          continue;
        }
      }

      const uri = TIER_URIS[tier];
      report(`MongoDB started successfully (${tier})`);
      log.info(`Auto-started MongoDB with tier: ${tier}`);
      return { success: true, tier, uri };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`${tier} failed: ${msg}`);
      report(`${tier} failed, trying next tier...`);
    }
  }

  // Clean up last tier's containers before reporting failure
  await stopMongoDBCompose(composeFile).catch(() => {});

  return { success: false, error: "All MongoDB start attempts failed" };
}

// ---------------------------------------------------------------------------
// Running Container Detection
// ---------------------------------------------------------------------------

/**
 * Check if ClawMongo Docker containers are already running.
 */
export async function getRunningClawMongoContainers(): Promise<{
  running: boolean;
  tier?: ComposeTier;
  containers: string[];
}> {
  const containers: string[] = [];

  // Check fullstack containers
  try {
    const mongodState = await dockerContainerState("clawmongo-mongod");
    if (mongodState.running) {
      containers.push("clawmongo-mongod");
    }
    const mongotState = await dockerContainerState("clawmongo-mongot");
    if (mongotState.running) {
      containers.push("clawmongo-mongot");
    }
    if (containers.includes("clawmongo-mongod") && containers.includes("clawmongo-mongot")) {
      return { running: true, tier: "fullstack", containers };
    }
    if (containers.includes("clawmongo-mongod")) {
      return { running: true, tier: "replicaset", containers };
    }
  } catch {
    // Docker not available
  }

  // Check standalone
  try {
    const standaloneState = await dockerContainerState("clawmongo-mongod-standalone");
    if (standaloneState.running) {
      return {
        running: true,
        tier: "standalone",
        containers: ["clawmongo-mongod-standalone"],
      };
    }
  } catch {
    // Docker not available
  }

  return { running: false, containers: [] };
}

// ---------------------------------------------------------------------------
// Image Pull with Progress
// ---------------------------------------------------------------------------

/**
 * Pull a Docker image with progress reporting.
 * Returns true on success, false on failure (never throws).
 */
export async function pullImageWithProgress(
  image: string,
  onProgress?: (message: string) => void,
): Promise<boolean> {
  const report = onProgress ?? (() => {});
  report(`Pulling ${image}...`);
  try {
    await execDockerRaw(["pull", image]);
    report(`${image} ready`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to pull ${image}: ${msg}`);
    report(`Failed to pull ${image}`);
    return false;
  }
}
