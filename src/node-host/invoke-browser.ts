import fsPromises from "node:fs/promises";
import { resolveBrowserConfig } from "../browser/config.js";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "../browser/control-service.js";
import { createBrowserRouteDispatcher } from "../browser/routes/dispatcher.js";
import { loadConfig } from "../config/config.js";
import { detectMime } from "../media/mime.js";
import { withTimeout } from "./with-timeout.js";

type BrowserProxyParams = {
  method?: string;
  path?: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
};

type BrowserProxyFile = {
  path: string;
  base64: string;
  mimeType?: string;
};

type BrowserProxyResult = {
  result: unknown;
  files?: BrowserProxyFile[];
};

const BROWSER_PROXY_MAX_FILE_BYTES = 10 * 1024 * 1024;

function normalizeProfileAllowlist(raw?: string[]): string[] {
  return Array.isArray(raw) ? raw.map((entry) => entry.trim()).filter(Boolean) : [];
}

function resolveBrowserProxyConfig() {
  const cfg = loadConfig();
  const proxy = cfg.nodeHost?.browserProxy;
  const allowProfiles = normalizeProfileAllowlist(proxy?.allowProfiles);
  const enabled = proxy?.enabled !== false;
  return { enabled, allowProfiles };
}

let browserControlReady: Promise<void> | null = null;

async function ensureBrowserControlService(): Promise<void> {
  if (browserControlReady) {
    return browserControlReady;
  }
  browserControlReady = (async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    if (!resolved.enabled) {
      throw new Error("browser control disabled");
    }
    const started = await startBrowserControlServiceFromConfig();
    if (!started) {
      throw new Error("browser control disabled");
    }
  })();
  return browserControlReady;
}

function isProfileAllowed(params: { allowProfiles: string[]; profile?: string | null }) {
  const { allowProfiles, profile } = params;
  if (!allowProfiles.length) {
    return true;
  }
  if (!profile) {
    return false;
  }
  return allowProfiles.includes(profile.trim());
}

function collectBrowserProxyPaths(payload: unknown): string[] {
  const paths = new Set<string>();
  const obj =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
  if (!obj) {
    return [];
  }
  if (typeof obj.path === "string" && obj.path.trim()) {
    paths.add(obj.path.trim());
  }
  if (typeof obj.imagePath === "string" && obj.imagePath.trim()) {
    paths.add(obj.imagePath.trim());
  }
  const download = obj.download;
  if (download && typeof download === "object") {
    const dlPath = (download as Record<string, unknown>).path;
    if (typeof dlPath === "string" && dlPath.trim()) {
      paths.add(dlPath.trim());
    }
  }
  return [...paths];
}

async function readBrowserProxyFile(filePath: string): Promise<BrowserProxyFile | null> {
  const stat = await fsPromises.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    return null;
  }
  if (stat.size > BROWSER_PROXY_MAX_FILE_BYTES) {
    throw new Error(
      `browser proxy file exceeds ${Math.round(BROWSER_PROXY_MAX_FILE_BYTES / (1024 * 1024))}MB`,
    );
  }
  const buffer = await fsPromises.readFile(filePath);
  const mimeType = await detectMime({ buffer, filePath });
  return { path: filePath, base64: buffer.toString("base64"), mimeType };
}

function decodeParams<T>(raw?: string | null): T {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  return JSON.parse(raw) as T;
}

export async function runBrowserProxyCommand(paramsJSON?: string | null): Promise<string> {
  const params = decodeParams<BrowserProxyParams>(paramsJSON);
  const pathValue = typeof params.path === "string" ? params.path.trim() : "";
  if (!pathValue) {
    throw new Error("INVALID_REQUEST: path required");
  }
  const proxyConfig = resolveBrowserProxyConfig();
  if (!proxyConfig.enabled) {
    throw new Error("UNAVAILABLE: node browser proxy disabled");
  }

  await ensureBrowserControlService();
  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const requestedProfile = typeof params.profile === "string" ? params.profile.trim() : "";
  const allowedProfiles = proxyConfig.allowProfiles;
  if (allowedProfiles.length > 0) {
    if (pathValue !== "/profiles") {
      const profileToCheck = requestedProfile || resolved.defaultProfile;
      if (!isProfileAllowed({ allowProfiles: allowedProfiles, profile: profileToCheck })) {
        throw new Error("INVALID_REQUEST: browser profile not allowed");
      }
    } else if (requestedProfile) {
      if (!isProfileAllowed({ allowProfiles: allowedProfiles, profile: requestedProfile })) {
        throw new Error("INVALID_REQUEST: browser profile not allowed");
      }
    }
  }

  const method = typeof params.method === "string" ? params.method.toUpperCase() : "GET";
  const path = pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
  const body = params.body;
  const query: Record<string, unknown> = {};
  if (requestedProfile) {
    query.profile = requestedProfile;
  }
  const rawQuery = params.query ?? {};
  for (const [key, value] of Object.entries(rawQuery)) {
    if (value === undefined || value === null) {
      continue;
    }
    query[key] = typeof value === "string" ? value : String(value);
  }

  const dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
  const response = await withTimeout(
    (signal) =>
      dispatcher.dispatch({
        method: method === "DELETE" ? "DELETE" : method === "POST" ? "POST" : "GET",
        path,
        query,
        body,
        signal,
      }),
    params.timeoutMs,
    "browser proxy request",
  );
  if (response.status >= 400) {
    const message =
      response.body && typeof response.body === "object" && "error" in response.body
        ? String((response.body as { error?: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }

  const result = response.body;
  if (allowedProfiles.length > 0 && path === "/profiles") {
    const obj =
      typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
    const profiles = Array.isArray(obj.profiles) ? obj.profiles : [];
    obj.profiles = profiles.filter((entry) => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      const name = (entry as Record<string, unknown>).name;
      return typeof name === "string" && allowedProfiles.includes(name);
    });
  }

  let files: BrowserProxyFile[] | undefined;
  const paths = collectBrowserProxyPaths(result);
  if (paths.length > 0) {
    const loaded = await Promise.all(
      paths.map(async (p) => {
        try {
          const file = await readBrowserProxyFile(p);
          if (!file) {
            throw new Error("file not found");
          }
          return file;
        } catch (err) {
          throw new Error(`browser proxy file read failed for ${p}: ${String(err)}`, {
            cause: err,
          });
        }
      }),
    );
    if (loaded.length > 0) {
      files = loaded;
    }
  }

  const payload: BrowserProxyResult = files ? { result, files } : { result };
  return JSON.stringify(payload);
}
