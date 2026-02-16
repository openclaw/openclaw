export type DockerErrorType =
  | "not-installed"
  | "daemon-not-running"
  | "permission-denied"
  | "image-not-found"
  | "port-conflict"
  | "network-conflict"
  | "volume-conflict"
  | "compose-not-found"
  | "unknown";

const ERROR_PATTERNS: Array<[RegExp, DockerErrorType]> = [
  [/command not found.*docker|docker.*not found/i, "not-installed"],
  [/Cannot connect to the Docker daemon|Is the docker daemon running/i, "daemon-not-running"],
  [/permission denied/i, "permission-denied"],
  [/manifest.*not found|no matching manifest/i, "image-not-found"],
  [/port is already allocated|address already in use|Bind.*failed/i, "port-conflict"],
  [/network.*was found but|network.*already exists/i, "network-conflict"],
  [/volume.*already exists|volume.*in use/i, "volume-conflict"],
  [/no configuration file provided|not a compose file/i, "compose-not-found"],
];

/**
 * Classify a Docker error message into a known error type.
 * Uses regex patterns to detect common Docker failure modes.
 */
export function classifyDockerError(errorMessage: string): DockerErrorType {
  for (const [pattern, type] of ERROR_PATTERNS) {
    if (pattern.test(errorMessage)) {
      return type;
    }
  }
  return "unknown";
}

const USER_MESSAGES: Record<DockerErrorType, string> = {
  "not-installed":
    "Docker is not installed.\nInstall Docker Desktop: https://www.docker.com/products/docker-desktop/",
  "daemon-not-running":
    "Docker is installed but not running.\nPlease start Docker Desktop and try again.",
  "permission-denied":
    "Docker permission denied.\nOn Linux, add your user to the docker group: sudo usermod -aG docker $USER\nThen log out and back in.",
  "image-not-found":
    "A required Docker image could not be found.\nCheck your internet connection and try again.",
  "port-conflict":
    "Port 27017 is already in use.\nStop the service using this port, or configure a different port.",
  "network-conflict":
    "A Docker network conflict was detected.\nRun: docker network rm clawmongo-net\nThen try again.",
  "volume-conflict":
    "A Docker volume conflict was detected.\nRun: docker volume prune\nThen try again.",
  "compose-not-found":
    "Docker Compose configuration not found.\nMake sure the ClawMongo package is properly installed.",
  unknown: "An unexpected Docker error occurred.\nCheck Docker Desktop is running and try again.",
};

/**
 * Get a user-friendly message for a Docker error type.
 */
export function dockerErrorMessage(type: DockerErrorType): string {
  return USER_MESSAGES[type];
}
