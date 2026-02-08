/**
 * FUSE (remote control) mechanism for OpenClaw gateway.
 * Checks https://raw.githubusercontent.com/openclaw/openclaw/refs/heads/main/FUSE.txt
 * for remote control commands: HOLD, UPGRADE, ANNOUNCE.
 *
 * HOLD commands suspend cron job execution (not the gateway itself).
 * This module only fetches FUSE when a cron job is about to execute,
 * unless both missionCritical and manualUpgrade are enabled (in which case
 * FUSE polling is skipped entirely since HOLD/UPGRADE commands would be ignored).
 */

import type { OpenClawConfig } from "../../config/config.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { runGatewayUpdate } from "../../infra/update-runner.js";
import { runCommandWithTimeout } from "../../process/exec.js";

const FUSE_URL = "https://raw.githubusercontent.com/openclaw/openclaw/refs/heads/main/FUSE.txt";
const FUSE_FETCH_TIMEOUT_MS = 5000;
const UPGRADE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const RESTART_DELAY_MS = 2000; // 2 seconds

// Upgrade state lock to prevent concurrent upgrades
let upgradeInProgress = false;

/**
 * Check if a git tag exists locally.
 */
async function tagExistsLocally(root: string, tag: string): Promise<boolean> {
  try {
    const result = await runCommandWithTimeout(["git", "-C", root, "tag", "--list", tag], {
      timeoutMs: 5000,
    });
    if (result.code !== 0) {
      return false;
    }
    // Check if the tag appears in the output (one tag per line)
    const tags = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return tags.includes(tag);
  } catch {
    return false;
  }
}

/**
 * Perform upgrade to specified tag/version.
 * Only proceeds if the tag does not already exist locally (forward upgrades only),
 * unless the version ends with '!' which forces the upgrade.
 */
async function performUpgrade(
  version: string,
  gateway: { log: (msg: string) => void },
): Promise<boolean> {
  // Check if an upgrade is already in progress
  if (upgradeInProgress) {
    gateway.log("Upgrade already in progress, skipping duplicate request");
    return false;
  }

  upgradeInProgress = true;
  try {
    const root = await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });

    if (!root) {
      gateway.log("Upgrade skipped: could not resolve package root");
      return false;
    }

    // Check if force flag is present (version ends with '!')
    const forceUpgrade = version.endsWith("!");
    const cleanVersion = forceUpgrade ? version.slice(0, -1) : version;

    // Check if tag already exists locally (prevent downgrades)
    // Skip this check if force flag is present
    if (!forceUpgrade) {
      const tagExists = await tagExistsLocally(root, cleanVersion);
      if (tagExists) {
        gateway.log(
          `Upgrade skipped: tag ${cleanVersion} already exists locally (forward upgrades only)`,
        );
        return false;
      }
    } else {
      gateway.log(`Force upgrade requested (version ends with '!'), skipping downgrade protection`);
    }

    gateway.log(`Starting upgrade to ${cleanVersion}...`);

    const result = await runGatewayUpdate({
      cwd: root ?? process.cwd(),
      argv1: process.argv[1],
      tag: cleanVersion,
      timeoutMs: UPGRADE_TIMEOUT_MS,
      progress: {
        onStepStart: (step) => {
          gateway.log(`[${step.index + 1}/${step.total}] ${step.name}...`);
        },
        onStepComplete: (step) => {
          if (step.exitCode !== 0) {
            gateway.log(`[${step.index + 1}/${step.total}] ${step.name} failed`);
          }
        },
      },
    });

    if (result.status === "ok") {
      const afterVersion = result.after?.version ?? cleanVersion;
      gateway.log(`Upgrade to ${afterVersion} completed successfully`);

      // Schedule restart
      gateway.log(`Restarting gateway in ${RESTART_DELAY_MS / 1000} seconds...`);
      scheduleGatewaySigusr1Restart({
        delayMs: RESTART_DELAY_MS,
        reason: `upgrade to ${afterVersion}`,
      });

      return true;
    }

    if (result.status === "skipped") {
      gateway.log(`Upgrade skipped: ${result.reason ?? "unknown reason"}`);
      return false;
    }

    // Error case
    const failedStep = result.steps.find((s) => s.exitCode !== 0);
    const errorDetail = failedStep
      ? `${failedStep.name}: ${failedStep.stderrTail ?? "unknown error"}`
      : (result.reason ?? "unknown error");
    gateway.log(`Upgrade failed: ${errorDetail}`);
    return false;
  } catch (err) {
    gateway.log(`Upgrade error: ${String(err)}`);
    return false;
  } finally {
    upgradeInProgress = false;
  }
}

// Minimal response interface for our use case
interface FuseResponse {
  ok: boolean;
  status?: number;
  statusText?: string;
  text(): Promise<string>;
}

// Fetch that handles file:// URLs
async function fetchURL(url: string | URL, options?: RequestInit): Promise<FuseResponse> {
  const urlString = typeof url === "string" ? url : url.toString();

  if (urlString.startsWith("file://")) {
    // Handle file:// URLs by reading from filesystem
    const filePath = urlString.replace("file://", "");
    try {
      const { readFileSync } = await import("node:fs");
      const content = readFileSync(filePath, "utf-8");
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => content,
      };
    } catch {
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "",
      };
    }
  }

  // For non-file URLs, use Node fetch
  return await fetch(url, options);
}

/**
 * Fetch and check FUSE circuit breaker to determine if cron processing should proceed.
 * Returns true if cron should proceed, false if suspended.
 */
export async function checkCircuitBreaker(
  config: OpenClawConfig,
  gateway: { log: (msg: string) => void },
): Promise<boolean> {
  // Skip FUSE polling entirely if both missionCritical and manualUpgrade are set
  const missionCritical = config.update?.missionCritical ?? false;
  const manualUpgrade = config.update?.manualUpgrade ?? false;

  if (missionCritical && manualUpgrade) {
    // Both options set - no need to fetch FUSE at all
    // Note: This means ANNOUNCE commands will also be skipped, but this is acceptable
    // since users with these settings have opted out of remote control entirely
    return true;
  }

  let content: string;
  const fuseUrl = config.update?.fuseUrl ?? FUSE_URL;

  // Set up abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FUSE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetchURL(fuseUrl, {
      headers: {
        "User-Agent": "openclaw-gateway",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      // Fetch failed, allow processing (fail-open)
      return true;
    }

    const fullText = await response.text();
    // Only process the first line to prevent comments/documentation from being interpreted
    // Note: We trim the line to remove leading/trailing whitespace
    const firstLine = fullText.split("\n")[0] ?? "";
    content = firstLine.trim();
  } catch {
    // Network error or timeout, allow processing (fail-open)
    return true;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!content) {
    return true;
  }

  // HOLD command - suspends cron jobs
  if (content.startsWith("HOLD")) {
    const reason = content.length <= 4 ? "." : content.substring(4);

    if (!missionCritical) {
      gateway.log(`Processing suspended${reason}`);
      return false;
    }

    gateway.log("Processing suspended centrally but you have opted out; processing continues.");
    return true;
  }

  // UPGRADE command
  if (content.startsWith("UPGRADE")) {
    // Check for proper format with space
    if (!content.startsWith("UPGRADE ")) {
      gateway.log("Invalid UPGRADE command: expected format 'UPGRADE version'");
      return true;
    }

    const version = content.substring(8).trim();

    // Validate that a version was provided
    if (!version) {
      gateway.log("Invalid UPGRADE command: no version specified");
      return true;
    }

    if (!manualUpgrade) {
      // Trigger auto-upgrade (non-blocking - runs in background)
      void performUpgrade(version, gateway);
    } else {
      gateway.log(`Upgrade ${version} available. Type openclaw upgrade ${version} into terminal.`);
    }

    // Allow cron to continue regardless of upgrade mode
    return true;
  }

  // ANNOUNCE command
  if (content.startsWith("ANNOUNCE")) {
    // Check for proper format with space
    if (!content.startsWith("ANNOUNCE ")) {
      gateway.log("Invalid ANNOUNCE command: expected format 'ANNOUNCE message'");
      return true;
    }

    const message = content.substring(9).trim();

    // Validate that a message was provided
    if (!message) {
      gateway.log("Invalid ANNOUNCE command: no message specified");
      return true;
    }

    gateway.log(message);
    return true;
  }

  return true;
}
