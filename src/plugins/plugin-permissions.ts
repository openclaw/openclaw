/**
 * Plugin Permission System
 *
 * Defines granular permissions for plugin sandbox execution to prevent
 * unauthorized access to system resources.
 */

export type PluginPermissions = {
  /** Allowed filesystem paths (read/write access) */
  filesystem?: {
    read?: string[];
    write?: string[];
  };
  /** Allowed network domains/IPs */
  network?: {
    allowlist?: string[];
    blocklist?: string[];
  };
  /** Maximum memory in MB (default: 128MB) */
  memory?: number;
  /** Maximum CPU time in milliseconds (default: 5000ms) */
  cpu?: number;
  /** Allow access to environment variables (default: false) */
  env?: boolean;
  /** Allowed environment variable names (if env is true) */
  envVars?: string[];
  /** Allow child process spawning (default: false) */
  childProcess?: boolean;
  /** Allow native Node.js module access (default: false) */
  nativeModules?: boolean;
  /** Specific Node.js modules allowed */
  allowedModules?: string[];
};

export const DEFAULT_PLUGIN_PERMISSIONS: Required<PluginPermissions> = {
  filesystem: {
    read: [],
    write: [],
  },
  network: {
    allowlist: [],
    blocklist: [],
  },
  memory: 128, // 128MB default
  cpu: 5000, // 5 seconds default
  env: false,
  envVars: [],
  childProcess: false,
  nativeModules: false,
  allowedModules: [],
};

/**
 * Validates and normalizes plugin permissions
 */
export function normalizePluginPermissions(
  permissions?: Partial<PluginPermissions>,
): Required<PluginPermissions> {
  const normalized = { ...DEFAULT_PLUGIN_PERMISSIONS };

  if (permissions) {
    if (permissions.filesystem) {
      normalized.filesystem = {
        read: permissions.filesystem.read ?? [],
        write: permissions.filesystem.write ?? [],
      };
    }
    if (permissions.network) {
      normalized.network = {
        allowlist: permissions.network.allowlist ?? [],
        blocklist: permissions.network.blocklist ?? [],
      };
    }
    if (typeof permissions.memory === "number" && permissions.memory > 0) {
      // Cap at 512MB to prevent excessive memory usage
      normalized.memory = Math.min(permissions.memory, 512);
    }
    if (typeof permissions.cpu === "number" && permissions.cpu > 0) {
      // Cap at 30 seconds
      normalized.cpu = Math.min(permissions.cpu, 30000);
    }
    normalized.env = permissions.env ?? false;
    normalized.envVars = permissions.envVars ?? [];
    normalized.childProcess = permissions.childProcess ?? false;
    normalized.nativeModules = permissions.nativeModules ?? false;
    normalized.allowedModules = permissions.allowedModules ?? [];
  }

  return normalized;
}

/**
 * Checks if a filesystem path is allowed based on permissions
 */
export function isPathAllowed(
  path: string,
  mode: "read" | "write",
  permissions: Required<PluginPermissions>,
): boolean {
  const allowedPaths = mode === "read" ? permissions.filesystem.read : permissions.filesystem.write;

  if (allowedPaths.length === 0) {
    return false;
  }

  // Normalize path for comparison
  const normalizedPath = path.replace(/\\/g, "/");

  return allowedPaths.some((allowed) => {
    const normalizedAllowed = allowed.replace(/\\/g, "/");
    // Check if path starts with allowed path or is exact match
    return (
      normalizedPath === normalizedAllowed || normalizedPath.startsWith(normalizedAllowed + "/")
    );
  });
}

/**
 * Checks if a network domain is allowed based on permissions
 */
export function isDomainAllowed(domain: string, permissions: Required<PluginPermissions>): boolean {
  const { allowlist, blocklist } = permissions.network;

  // If blocklist contains the domain, deny
  if (blocklist.some((blocked) => domain.includes(blocked))) {
    return false;
  }

  // If allowlist is empty, allow all (unless blocked)
  if (allowlist.length === 0) {
    return true;
  }

  // Check if domain matches allowlist
  return allowlist.some((allowed) => domain.includes(allowed));
}

/**
 * Checks if a module import is allowed based on permissions
 */
export function isModuleAllowed(
  moduleName: string,
  permissions: Required<PluginPermissions>,
): boolean {
  // If native modules not allowed and this is a Node.js built-in, deny
  const nodeBuiltins = [
    "fs",
    "fs/promises",
    "path",
    "os",
    "process",
    "child_process",
    "cluster",
    "crypto",
    "dgram",
    "dns",
    "domain",
    "events",
    "http",
    "https",
    "http2",
    "net",
    "perf_hooks",
    "readline",
    "repl",
    "stream",
    "string_decoder",
    "sys",
    "timers",
    "tls",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "worker_threads",
    "zlib",
  ];

  const isBuiltin = nodeBuiltins.includes(moduleName) || moduleName.startsWith("node:");

  if (isBuiltin && !permissions.nativeModules) {
    return false;
  }

  // If allowedModules is specified, check if module is in the list
  if (permissions.allowedModules.length > 0) {
    return permissions.allowedModules.includes(moduleName);
  }

  // If native modules allowed but no specific list, allow all
  return permissions.nativeModules;
}

/**
 * Checks if an environment variable access is allowed
 */
export function isEnvVarAllowed(
  varName: string,
  permissions: Required<PluginPermissions>,
): boolean {
  if (!permissions.env) {
    return false;
  }

  // If specific env vars are listed, only allow those
  if (permissions.envVars.length > 0) {
    return permissions.envVars.includes(varName);
  }

  // If env is true but no specific vars, allow all
  return true;
}
