/**
 * Container escape-attempt detection module (DC-9).
 *
 * Checks a running Docker container for the five primary escape-indicator
 * categories: host-namespace access via /proc/1/cgroup, default-route
 * presence in /proc/net/route (network escape), privileged capabilities in
 * /proc/self/status, writable host-path mounts in /proc/mounts, and
 * dangerous capability flags (CAP_SYS_ADMIN, CAP_NET_ADMIN, CAP_SYS_MODULE,
 * CAP_BPF [kernel 5.8+], CAP_PERFMON [kernel 5.8+]).
 *
 * **Scope:** All checks invoke `docker exec` against the target container ID.
 * The caller is responsible for ensuring the Docker daemon is accessible.
 *
 * **console.error usage:** `emergencyContainerKill` writes to stderr via
 * `console.error` because it runs during a critical shutdown path where the
 * structured logging pipeline may itself be unavailable (DC-9).  Callers
 * should treat any stderr output from this function as a high-severity
 * operational signal.
 */
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContainerEscapeIndicatorType = "process" | "file" | "network" | "mount" | "capability";

export type ContainerEscapeIndicator = {
  type: ContainerEscapeIndicatorType;
  severity: "critical" | "warn";
  description: string;
  evidence: string;
  timestamp: number;
};

export type ContainerMonitorResult = {
  containerId: string;
  indicators: ContainerEscapeIndicator[];
  checkedAt: number;
  escaped: boolean;
};

// ---------------------------------------------------------------------------
// Container ID Validation (SECURITY CRITICAL)
// ---------------------------------------------------------------------------

/**
 * Docker container ID format: 64 hex characters (full) or 12+ hex characters (short)
 * Also allows container names: alphanumeric, underscores, hyphens, dots (max 128 chars)
 */
const CONTAINER_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/**
 * Validates container ID to prevent command injection attacks.
 * @throws Error if container ID contains invalid characters
 */
export function validateContainerId(containerId: string): void {
  if (!containerId || typeof containerId !== "string") {
    throw new Error("Container ID must be a non-empty string");
  }

  if (containerId.length > 128) {
    throw new Error("Container ID exceeds maximum length of 128 characters");
  }

  if (!CONTAINER_ID_REGEX.test(containerId)) {
    throw new Error(
      `Invalid container ID format: "${containerId}". Must be alphanumeric with optional underscores, hyphens, or dots.`,
    );
  }

  // Additional checks for shell metacharacters (defense in depth)
  const dangerousChars = /[;&|`$(){}[\]<>\\!#*?~]/;
  if (dangerousChars.test(containerId)) {
    throw new Error(`Container ID contains dangerous characters: "${containerId}"`);
  }
}

// ---------------------------------------------------------------------------
// Sensitive paths that should never be accessed from container
// ---------------------------------------------------------------------------

/**
 * Explicit paths (no glob patterns - they don't work with `test -e`)
 * For user home directories, we check dynamically via /etc/passwd
 */
const SENSITIVE_HOST_PATHS = [
  "/var/run/docker.sock",
  "/proc/1/cgroup",
  "/proc/1/ns",
  "/host",
  "/hostfs",
  "/etc/shadow",
  "/etc/passwd",
  "/etc/sudoers",
  "/root/.ssh",
  "/root/.gnupg",
  "/root/.aws",
  "/var/run/secrets",
  "/var/run/secrets/kubernetes.io",
];

// ---------------------------------------------------------------------------
// Dangerous Linux Capabilities (bitmask values)
// Reference: include/uapi/linux/capability.h
// ---------------------------------------------------------------------------

/**
 * Map of dangerous capabilities that indicate potential escape vectors.
 * Values are bit positions (0-indexed) in the capability bitmask.
 */
const DANGEROUS_CAPABILITIES: Record<string, number> = {
  CAP_SYS_ADMIN: 21, // Mount, namespace manipulation, many kernel features
  CAP_SYS_PTRACE: 19, // Process tracing - can escape namespaces
  CAP_SYS_MODULE: 16, // Load/unload kernel modules
  CAP_SYS_RAWIO: 17, // Raw I/O access
  CAP_NET_ADMIN: 12, // Network configuration (can affect host)
  CAP_NET_RAW: 13, // Raw sockets (can sniff traffic)
  CAP_DAC_READ_SEARCH: 2, // Bypass file read permission checks
  CAP_DAC_OVERRIDE: 1, // Bypass file permission checks
  CAP_SETUID: 7, // Change UID
  CAP_SETGID: 6, // Change GID
  CAP_MKNOD: 27, // Create device nodes
  CAP_SYS_CHROOT: 18, // Use chroot
  CAP_SYS_BOOT: 22, // Reboot system
  CAP_BPF: 39, // BPF operations (kernel 5.8+)
  CAP_PERFMON: 38, // Performance monitoring (kernel 5.8+)
};

/**
 * Check if a capability bitmask contains any dangerous capabilities.
 * Returns list of dangerous capabilities that are set.
 */
export function checkDangerousCapabilitiesBitmask(capHex: string): string[] {
  const dangerous: string[] = [];

  try {
    const capInt = BigInt(`0x${capHex}`);

    for (const [capName, bitPosition] of Object.entries(DANGEROUS_CAPABILITIES)) {
      const capBit = 1n << BigInt(bitPosition);
      if ((capInt & capBit) !== 0n) {
        dangerous.push(capName);
      }
    }
  } catch {
    // Invalid hex string - return empty (will be handled elsewhere)
  }

  return dangerous;
}

// ---------------------------------------------------------------------------
// Detection Functions
// ---------------------------------------------------------------------------

/**
 * Check if container processes are accessing host namespace
 */
async function checkHostProcessAccess(containerId: string): Promise<string[]> {
  const violations: string[] = [];

  try {
    // Get container's PID namespace
    const result = await runDockerCommand(["exec", containerId, "cat", "/proc/1/cgroup"]);

    // If we can read /proc/1/cgroup and it doesn't contain docker/containerd,
    // the container may have host PID namespace access
    if (
      result.stdout &&
      !result.stdout.includes("docker") &&
      !result.stdout.includes("containerd")
    ) {
      violations.push("Container has potential host PID namespace access");
    }
  } catch {
    // Cannot check - container may be stopped or inaccessible
  }

  return violations;
}

/**
 * Check for access to sensitive host files
 */
async function checkSensitiveFileAccess(containerId: string): Promise<string[]> {
  const violations: string[] = [];

  for (const sensitivePath of SENSITIVE_HOST_PATHS) {
    try {
      const result = await runDockerCommand(["exec", containerId, "test", "-e", sensitivePath]);

      if (result.code === 0) {
        violations.push(`Sensitive path accessible: ${sensitivePath}`);
      }
    } catch {
      // Path not accessible - expected behavior
    }
  }

  return violations;
}

/**
 * Check for network connections to host
 */
async function checkNetworkEscape(containerId: string): Promise<string | null> {
  try {
    // Check if container can reach host gateway
    const result = await runDockerCommand(["exec", containerId, "cat", "/proc/net/route"]);

    // Look for default gateway pointing to host
    if (result.stdout && result.stdout.includes("00000000")) {
      // Container has network routing - check if it can reach host
      const hostCheck = await runDockerCommand([
        "exec",
        containerId,
        "timeout",
        "1",
        "cat",
        "/proc/net/tcp",
      ]);

      if (hostCheck.stdout && hostCheck.stdout.split("\n").length > 2) {
        return "Container has active network connections";
      }
    }
  } catch {
    // Cannot check network state
  }

  return null;
}

/**
 * Check for dangerous Linux capabilities
 * Only flags specific dangerous capabilities, not all capabilities
 */
async function checkDangerousCapabilities(containerId: string): Promise<string[]> {
  const violations: string[] = [];

  try {
    const result = await runDockerCommand(["exec", containerId, "cat", "/proc/self/status"]);

    if (result.stdout) {
      const capLine = result.stdout.split("\n").find((line) => line.startsWith("CapEff:"));

      if (capLine) {
        const capHex = capLine.split(":")[1]?.trim();
        if (capHex) {
          // Only check for specific dangerous capabilities, not all
          const dangerousCaps = checkDangerousCapabilitiesBitmask(capHex);

          if (dangerousCaps.length > 0) {
            violations.push(`Container has dangerous capabilities: ${dangerousCaps.join(", ")}`);
          }
        }
      }
    }
  } catch {
    // Cannot check capabilities
  }

  return violations;
}

/**
 * Check for suspicious mount points
 */
async function checkSuspiciousMounts(containerId: string): Promise<string[]> {
  const violations: string[] = [];

  try {
    const result = await runDockerCommand(["exec", containerId, "cat", "/proc/mounts"]);

    if (result.stdout) {
      const lines = result.stdout.split("\n");

      for (const line of lines) {
        // Check for host filesystem mounts
        if (line.includes("/hostfs") || line.includes("/host") || line.includes("docker.sock")) {
          violations.push(`Suspicious mount detected: ${line.split(" ")[1]}`);
        }

        // Check for bind mounts to sensitive paths
        if (line.includes("/etc/passwd") || line.includes("/etc/shadow")) {
          violations.push(`Credential file mounted: ${line.split(" ")[1]}`);
        }
      }
    }
  } catch {
    // Cannot check mounts
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Docker Command Helper
// ---------------------------------------------------------------------------

type DockerCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

async function runDockerCommand(args: string[]): Promise<DockerCommandResult> {
  return new Promise((resolve) => {
    const proc = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });

    proc.on("error", () => {
      resolve({ code: 1, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run comprehensive container escape detection
 * Uses parallel execution for performance
 */
export async function detectContainerEscape(containerId: string): Promise<ContainerMonitorResult> {
  // Validate container ID to prevent command injection
  validateContainerId(containerId);

  const indicators: ContainerEscapeIndicator[] = [];
  const timestamp = Date.now();

  // Run all checks in parallel for performance
  const [processViolations, fileViolations, networkEscape, capViolations, mountViolations] =
    await Promise.all([
      checkHostProcessAccess(containerId),
      checkSensitiveFileAccess(containerId),
      checkNetworkEscape(containerId),
      checkDangerousCapabilities(containerId),
      checkSuspiciousMounts(containerId),
    ]);

  // Process host process access violations
  for (const violation of processViolations) {
    indicators.push({
      type: "process",
      severity: "critical",
      description: "Container process accessing host namespace",
      evidence: violation,
      timestamp,
    });
  }

  // Process sensitive file access violations
  for (const violation of fileViolations) {
    indicators.push({
      type: "file",
      severity: "critical",
      description: "Container accessing host files",
      evidence: violation,
      timestamp,
    });
  }

  // Process network escape
  if (networkEscape) {
    indicators.push({
      type: "network",
      severity: "warn",
      description: "Container has network connectivity",
      evidence: networkEscape,
      timestamp,
    });
  }

  // Process dangerous capabilities
  for (const violation of capViolations) {
    indicators.push({
      type: "capability",
      severity: "critical",
      description: "Container has dangerous Linux capabilities",
      evidence: violation,
      timestamp,
    });
  }

  // Process suspicious mounts
  for (const violation of mountViolations) {
    indicators.push({
      type: "mount",
      severity: "critical",
      description: "Container has suspicious mount points",
      evidence: violation,
      timestamp,
    });
  }

  const escaped = indicators.some((i) => i.severity === "critical");

  return {
    containerId,
    indicators,
    checkedAt: timestamp,
    escaped,
  };
}

/**
 * Emergency kill container if escape detected
 * @throws Error if containerId is invalid (prevents command injection)
 */
export async function emergencyContainerKill(containerId: string): Promise<void> {
  // Validate container ID to prevent command injection (SECURITY CRITICAL)
  validateContainerId(containerId);

  // Kill with SIGKILL immediately
  await runDockerCommand(["kill", "--signal=SIGKILL", containerId]);

  // Force remove container
  await runDockerCommand(["rm", "-f", containerId]);

  // Log security incident (use sanitized ID after validation)
  console.error(
    `[SECURITY] Container ${containerId} killed due to escape attempt at ${new Date().toISOString()}`,
  );
}

/**
 * Monitor container and kill if escape detected
 * @throws Error if containerId is invalid (prevents command injection)
 */
export async function monitorContainerWithKill(
  containerId: string,
): Promise<ContainerMonitorResult> {
  // Validation happens in detectContainerEscape, but validate early for clear errors
  validateContainerId(containerId);

  const result = await detectContainerEscape(containerId);

  if (result.escaped) {
    await emergencyContainerKill(containerId);
  }

  return result;
}
