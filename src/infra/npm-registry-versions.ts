/**
 * Query the npm registry for package version metadata, including engine constraints.
 * Used by the engine compatibility system to find compatible plugin versions.
 */
import { fetchWithTimeout } from "../utils/fetch-timeout.js";

export type NpmVersionEntry = {
  version: string;
  engines?: Record<string, string>;
};

export type FetchPackageVersionsResult =
  | { ok: true; versions: NpmVersionEntry[] }
  | { ok: false; error: string };

/**
 * Fetch all published versions of an npm package along with their `engines` metadata.
 *
 * Uses the abbreviated packument endpoint (`application/vnd.npm.install-v1+json`)
 * for smaller payloads.
 */
export async function fetchPackageVersions(params: {
  packageName: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<FetchPackageVersionsResult> {
  const timeoutMs = params.timeoutMs ?? 5000;
  const packageName = params.packageName.trim();
  if (!packageName) {
    return { ok: false, error: "missing package name" };
  }

  const url = `https://registry.npmjs.org/${encodePackageName(packageName)}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: "application/vnd.npm.install-v1+json",
        },
      },
      timeoutMs,
      params.fetchFn,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: `npm registry request timed out after ${timeoutMs}ms` };
    }
    return { ok: false, error: `npm registry request failed: ${String(err)}` };
  }

  if (res.status === 404) {
    return { ok: false, error: `package not found on npm: ${packageName}` };
  }
  if (!res.ok) {
    return { ok: false, error: `npm registry returned HTTP ${res.status}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "failed to parse npm registry response" };
  }

  if (!body || typeof body !== "object") {
    return { ok: false, error: "unexpected npm registry response format" };
  }

  const versionsObj = (body as Record<string, unknown>).versions;
  if (!versionsObj || typeof versionsObj !== "object") {
    return { ok: true, versions: [] };
  }

  const entries: NpmVersionEntry[] = [];
  for (const [version, metadata] of Object.entries(versionsObj as Record<string, unknown>)) {
    if (!version || typeof version !== "string") {
      continue;
    }
    const entry: NpmVersionEntry = { version };
    if (metadata && typeof metadata === "object") {
      const engines = (metadata as Record<string, unknown>).engines;
      if (engines && typeof engines === "object") {
        entry.engines = engines as Record<string, string>;
      }
    }
    entries.push(entry);
  }

  return { ok: true, versions: entries };
}

/**
 * Encode a package name for use in the registry URL.
 * Scoped packages like @openclaw/foo need the @ and / encoded properly.
 */
function encodePackageName(name: string): string {
  if (name.startsWith("@")) {
    // Scoped package: encode the full scope/name
    return `@${encodeURIComponent(name.slice(1))}`;
  }
  return encodeURIComponent(name);
}
