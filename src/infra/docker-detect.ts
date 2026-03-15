import fs from "node:fs/promises";

export type DockerEnvironment = {
  /** Whether the process is running inside a Docker container. */
  isDocker: boolean;
  /** Whether the Docker socket is available for container management. */
  hasDockerSocket: boolean;
  /** The current container image reference (e.g. "ghcr.io/openclaw/openclaw:latest"). */
  currentImage: string | null;
  /** The image tag portion (e.g. "latest", "1.2.3", "1.2.3-beta.1"). */
  currentTag: string | null;
  /** The image repository without tag (e.g. "ghcr.io/openclaw/openclaw"). */
  imageRepo: string | null;
};

const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";
const DOCKERENV_PATH = "/.dockerenv";
const CGROUP_PATH = "/proc/1/cgroup";
const DEFAULT_IMAGE_REPO = "ghcr.io/openclaw/openclaw";

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect whether the current process is running inside a Docker container.
 *
 * Checks (in order):
 * 1. `OPENCLAW_DOCKER` env var (explicit opt-in/out)
 * 2. Presence of `/.dockerenv`
 * 3. `/proc/1/cgroup` containing "docker" or "containerd"
 */
export async function detectIsDocker(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  // Explicit env override
  const explicit = env.OPENCLAW_DOCKER;
  if (explicit === "1" || explicit === "true") {
    return true;
  }
  if (explicit === "0" || explicit === "false") {
    return false;
  }

  // /.dockerenv sentinel
  if (await fileExists(DOCKERENV_PATH)) {
    return true;
  }

  // cgroup-based detection
  try {
    const cgroup = await fs.readFile(CGROUP_PATH, "utf-8");
    if (cgroup.includes("docker") || cgroup.includes("containerd")) {
      return true;
    }
  } catch {
    // Not on Linux or no access — not Docker.
  }

  return false;
}

/**
 * Check whether the Docker socket is available at the given path.
 */
export async function detectDockerSocket(socketPath?: string): Promise<boolean> {
  const target = socketPath ?? DEFAULT_DOCKER_SOCKET;
  try {
    const stat = await fs.stat(target);
    return stat.isSocket?.() ?? false;
  } catch {
    return false;
  }
}

/**
 * Parse an image reference into repository and tag components.
 *
 * @example
 * parseImageRef("ghcr.io/openclaw/openclaw:1.2.3")
 * // => { repo: "ghcr.io/openclaw/openclaw", tag: "1.2.3" }
 */
export function parseImageRef(image: string): { repo: string; tag: string | null } {
  const trimmed = image.trim();
  if (!trimmed) {
    return { repo: "", tag: null };
  }
  // Handle digest references (repo@sha256:...)
  const digestIdx = trimmed.indexOf("@");
  if (digestIdx >= 0) {
    return { repo: trimmed.slice(0, digestIdx), tag: null };
  }
  // Find the last colon that appears after the last slash.
  // This correctly distinguishes port separators (before any slash)
  // from tag separators (always after the image name, which follows the last slash).
  const lastSlash = trimmed.lastIndexOf("/");
  const searchFrom = lastSlash >= 0 ? lastSlash + 1 : 0;
  const colonIdx = trimmed.indexOf(":", searchFrom);
  if (colonIdx < 0) {
    return { repo: trimmed, tag: null };
  }
  const tag = trimmed.slice(colonIdx + 1);
  // If the part after the colon is entirely digits it's a port number, not a tag.
  // e.g. "registry.example.com:5000" → { repo: "registry.example.com:5000", tag: null }
  if (/^\d+$/.test(tag)) {
    return { repo: trimmed, tag: null };
  }
  return { repo: trimmed.slice(0, colonIdx), tag: tag || null };
}

/**
 * Detect the full Docker environment context.
 *
 * Uses environment variables for image detection:
 * - `OPENCLAW_IMAGE`: explicit full image reference
 * - `OPENCLAW_IMAGE_TAG`: explicit tag override
 *
 * @param env - Process environment (defaults to `process.env`)
 * @param socketPath - Docker socket path override
 */
export async function detectDockerEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  socketPath?: string,
): Promise<DockerEnvironment> {
  const isDocker = await detectIsDocker(env);
  const hasDockerSocket = isDocker ? await detectDockerSocket(socketPath) : false;

  if (!isDocker) {
    return {
      isDocker: false,
      hasDockerSocket: false,
      currentImage: null,
      currentTag: null,
      imageRepo: null,
    };
  }

  // Resolve image reference
  const explicitImage = env.OPENCLAW_IMAGE?.trim() || null;
  const explicitTag = env.OPENCLAW_IMAGE_TAG?.trim() || null;

  let imageRepo: string | null = null;
  let currentTag: string | null = null;

  if (explicitImage) {
    const parsed = parseImageRef(explicitImage);
    imageRepo = parsed.repo || DEFAULT_IMAGE_REPO;
    currentTag = explicitTag ?? parsed.tag;
  } else {
    imageRepo = DEFAULT_IMAGE_REPO;
    currentTag = explicitTag ?? null;
  }

  const currentImage = currentTag ? `${imageRepo}:${currentTag}` : imageRepo;

  return {
    isDocker,
    hasDockerSocket,
    currentImage,
    currentTag,
    imageRepo,
  };
}
