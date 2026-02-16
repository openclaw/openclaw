import type { ComposeTier } from "../docker/mongodb-docker.js";
import type { WizardPrompter } from "./prompts.js";
import {
  checkDockerEnvironment,
  detectExistingMongoDB,
  autoStartMongoDB,
  getComposeFilePath,
  getRunningClawMongoContainers,
  isPortInUse,
} from "../docker/mongodb-docker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("wizard:mongo-auto");

// ---------------------------------------------------------------------------
// Auto-Setup Result Type
// ---------------------------------------------------------------------------

export type AutoSetupResult =
  | {
      success: true;
      uri: string;
      tier?: ComposeTier;
      source: "existing" | "docker-auto" | "docker-existing";
    }
  | {
      success: false;
      reason: string;
    };

// ---------------------------------------------------------------------------
// Tier Labels for User-Facing Messages
// ---------------------------------------------------------------------------

const TIER_LABELS: Record<ComposeTier, string> = {
  fullstack: "Full stack: replica set + mongot (ACID transactions, vector search, analytics)",
  replicaset: "Replica set (ACID transactions, change streams, no vector search)",
  standalone: "Standalone with basic features (no transactions, no vector search)",
};

// ---------------------------------------------------------------------------
// attemptAutoSetup
// ---------------------------------------------------------------------------

/**
 * Attempt zero-friction MongoDB auto-setup.
 * Order of operations:
 * 1. Detect existing MongoDB at localhost:27017
 * 2. Check Docker environment (CLI, daemon, compose)
 * 3. Check for already-running ClawMongo containers
 * 4. Check port 27017 is free
 * 5. Auto-start via docker-compose with tier fallback
 *
 * Returns { success: true, uri, tier?, source } on success.
 * Returns { success: false, reason } on failure (caller should fall through to manual URI prompt).
 */
export async function attemptAutoSetup(prompter: WizardPrompter): Promise<AutoSetupResult> {
  // 1. Detect existing MongoDB
  log.info("Checking for existing MongoDB...");
  const existing = await detectExistingMongoDB();
  if (existing.connected && existing.uri) {
    const label = existing.isDocker
      ? "Found MongoDB running in Docker"
      : "Found MongoDB running on localhost:27017";
    await prompter.note(label, "MongoDB Detected");
    return { success: true, uri: existing.uri, source: "existing" };
  }

  // 2. Check Docker environment
  log.info("Checking Docker environment...");
  const docker = await checkDockerEnvironment();
  if (!docker.installed) {
    log.info("Docker not installed, skipping auto-setup");
    return { success: false, reason: "Docker is not installed. Enter a MongoDB URI manually." };
  }
  if (!docker.daemonRunning) {
    log.info("Docker daemon not running, skipping auto-setup");
    return {
      success: false,
      reason: "Docker is installed but not running. Start Docker Desktop, or enter a MongoDB URI.",
    };
  }
  if (!docker.composeAvailable) {
    log.info("Docker Compose not available, skipping auto-setup");
    return {
      success: false,
      reason: "Docker Compose is not available. Install Docker Compose, or enter a MongoDB URI.",
    };
  }

  // 3. Check for already-running ClawMongo containers
  log.info("Checking for running ClawMongo containers...");
  const running = await getRunningClawMongoContainers();
  if (running.running && running.tier) {
    await prompter.note(`Found running ClawMongo containers (${running.tier})`, "MongoDB Detected");
    // Try to reconnect
    const reconnect = await detectExistingMongoDB();
    if (reconnect.connected && reconnect.uri) {
      return {
        success: true,
        uri: reconnect.uri,
        tier: running.tier,
        source: "docker-existing",
      };
    }
  }

  // 4. Check port 27017 is free
  const portInUse = await isPortInUse(27017);
  if (portInUse) {
    await prompter.note(
      "Port 27017 is in use by another service (not MongoDB).\n" +
        "Stop the service using port 27017, or enter a MongoDB URI on a different port.",
      "Port Conflict",
    );
    return {
      success: false,
      reason: "Port 27017 is in use. Free the port or provide a custom MongoDB URI.",
    };
  }

  // 5. Auto-start MongoDB via docker-compose
  const composeFile = getComposeFilePath();
  const progress = prompter.progress("Starting MongoDB via Docker...");

  const result = await autoStartMongoDB({
    composeFile,
    onProgress: (msg) => progress.update(msg),
  });

  if (result.success && result.tier && result.uri) {
    progress.stop("MongoDB is ready");
    const tierLabel = TIER_LABELS[result.tier];
    await prompter.note(tierLabel, "MongoDB Started");
    return {
      success: true,
      uri: result.uri,
      tier: result.tier,
      source: "docker-auto",
    };
  }

  progress.stop("Failed to start MongoDB");
  return {
    success: false,
    reason: result.error ?? "Failed to start MongoDB via Docker. Enter a MongoDB URI manually.",
  };
}
