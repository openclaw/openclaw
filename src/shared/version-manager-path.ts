import nodePath from "node:path";

const COMMON_VERSION_MANAGER_MARKERS = [
  "/.nvm/",
  "/.fnm/",
  "/.local/share/fnm/",
  "/.volta/",
  "/.asdf/",
  "/.n/",
  "/.nodenv/",
  "/.nodebrew/",
  "/nvs/",
];

export type NodeVersionManager = "nvm" | "fnm" | "volta" | "other" | "system";

/** Classify the selected executable, not merely an installed manager in the environment. */
export function resolveNodeVersionManager(
  executable: string,
  env: Record<string, string | undefined>,
): NodeVersionManager {
  const normalized = nodePath.posix.normalize(executable.replaceAll("\\", "/")).toLowerCase();
  for (const [manager, key] of [
    ["nvm", "NVM_DIR"],
    ["fnm", "FNM_DIR"],
    ["volta", "VOLTA_HOME"],
  ] as const) {
    const root = env[key]
      ? nodePath.posix.normalize(env[key].replaceAll("\\", "/")).replace(/\/$/, "").toLowerCase()
      : undefined;
    if (root && normalized.startsWith(`${root}/`)) {
      return manager;
    }
    if (
      COMMON_VERSION_MANAGER_MARKERS.some(
        (marker) => marker.includes(manager) && normalized.includes(marker),
      )
    ) {
      return manager;
    }
  }
  if (normalized.includes("/library/application support/fnm/")) {
    return "fnm";
  }
  return matchesVersionManagerPath(normalized, "daemon-runtime") ? "other" : "system";
}

// Callers own normalization and case handling; the profiles preserve their
// distinct CA-discovery, executable-selection, and service PATH policies.
export function matchesVersionManagerPath(
  path: string,
  profile: "linux-ca" | "daemon-runtime" | "service-path",
): boolean {
  return (
    COMMON_VERSION_MANAGER_MARKERS.some((marker) => path.includes(marker)) ||
    (profile !== "service-path" && path.includes("/.local/share/mise/")) ||
    (profile === "linux-ca" && path.includes("/.nvs/")) ||
    (profile === "daemon-runtime" && path.includes("/library/application support/fnm/"))
  );
}
