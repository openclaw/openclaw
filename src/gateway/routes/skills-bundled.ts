/**
 * GET /skills/bundled
 *   Returns the runtime envelope: committed manifest + image/runtime metadata
 *   from build-time env vars (OPENCLAW_IMAGE_TAG, OPENCLAW_IMAGE_SHA, OPENCLAW_SOURCE_SHA).
 *
 * GET /skills/bundled/:name
 *   Returns the raw SKILL.md body for one bundled canonical skill.
 *   404 on unknown name.
 *
 * Both routes require gateway bearer auth.
 * Manifest is read from /app/skills/manifest.json at module init (cached).
 * SKILL.md bodies are read from /app/skills/<name>/SKILL.md on demand.
 * No filesystem traversal outside the skills directory.
 */

import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthRateLimiter } from "../auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "../auth.js";
import { authorizeGatewayBearerRequestOrReply } from "../http-auth-helpers.js";
import { sendJson, sendText } from "../http-common.js";

// ── manifest types ─────────────────────────────────────────────────────────────

type SkillRequires = {
  env?: string[];
  bins?: string[];
};

type ManifestEntry = {
  contentHash: string;
  description: string;
  emoji: string;
  name: string;
  path: string;
  requires: SkillRequires;
};

type RuntimeEnvelope = {
  generatedAt: string;
  imageTag: string;
  imageSha: string;
  skills: ManifestEntry[];
  sourceSha: string;
};

// ── paths ─────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In production (docker image): files live at /app/skills/
// In development / tests: resolved relative to the dist output location.
const SKILLS_ROOT = resolveSkillsRoot();

function resolveSkillsRoot(): string {
  // Try /app/skills/ first (production container path).
  if (existsSync("/app/skills/manifest.json")) {
    return "/app/skills";
  }
  // Fallback: walk up from this file's compiled location to the repo root.
  // This file will be compiled to dist/gateway/routes/skills-bundled.js,
  // so repo root is three levels up.
  const fromDist = path.resolve(__dirname, "..", "..", "..", "skills");
  if (existsSync(path.join(fromDist, "manifest.json"))) {
    return fromDist;
  }
  return "/app/skills";
}

const MANIFEST_PATH = path.join(SKILLS_ROOT, "manifest.json");

// ── cached manifest ───────────────────────────────────────────────────────────

let _manifestCache: ManifestEntry[] | null = null;
let _manifestLoadError: string | null = null;

function loadManifest(): { ok: true; entries: ManifestEntry[] } | { ok: false; error: string } {
  if (_manifestLoadError !== null) {
    return { ok: false, error: _manifestLoadError };
  }
  if (_manifestCache !== null) {
    return { ok: true, entries: _manifestCache };
  }

  if (!existsSync(MANIFEST_PATH)) {
    _manifestLoadError = `skills/manifest.json not found at ${MANIFEST_PATH}`;
    return { ok: false, error: _manifestLoadError };
  }

  try {
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      _manifestLoadError = "skills/manifest.json is not a JSON array";
      return { ok: false, error: _manifestLoadError };
    }
    _manifestCache = parsed as ManifestEntry[];
    return { ok: true, entries: _manifestCache };
  } catch (err) {
    _manifestLoadError = `Failed to parse skills/manifest.json: ${String(err)}`;
    return { ok: false, error: _manifestLoadError };
  }
}

/** Exposed for tests — allows resetting the module-level cache. */
export function resetManifestCache(): void {
  _manifestCache = null;
  _manifestLoadError = null;
}

// ── runtime envelope ──────────────────────────────────────────────────────────

/**
 * Read a build-time env var, treating an unset OR empty-string value as
 * "unknown". The Dockerfile declares these as `ARG ... = ""` (empty default),
 * which means an unset build-arg passes through as an empty string at runtime
 * rather than as undefined — so `??` would not fall back. Always use this
 * helper instead of `process.env.X ?? "unknown"` for image/source metadata.
 */
function buildEnvOr(name: string, fallback: string): string {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") {
    return fallback;
  }
  return v;
}

function buildEnvelope(entries: ManifestEntry[]): RuntimeEnvelope {
  // imageSha is intentionally NOT populated by the gateway build pipeline:
  // the final Artifact Registry digest is not known inside a single-pass
  // `docker build` (it's produced by `docker push`). The dashboard will
  // attach the registry digest via the release-record join in Phase 3
  // (see docs/plans/canonical-skill-registry.md §8). Until then, this field
  // reports "unknown" — consumers should treat it as a known-missing value,
  // not as a verification field.
  return {
    generatedAt: new Date().toISOString(),
    imageTag: buildEnvOr("OPENCLAW_IMAGE_TAG", "unknown"),
    imageSha: buildEnvOr("OPENCLAW_IMAGE_SHA", "unknown"),
    skills: entries,
    sourceSha: buildEnvOr("OPENCLAW_SOURCE_SHA", "unknown"),
  };
}

// ── path guards ───────────────────────────────────────────────────────────────

/** Returns true only if `name` is a simple identifier (no slashes, dots, etc.) */
function isSafeSkillName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name);
}

// ── request handler ───────────────────────────────────────────────────────────

const BUNDLED_PREFIX = "/skills/bundled";

/**
 * Returns true if this handler handled the request (including auth failures),
 * false if the path doesn't match and the caller should try the next handler.
 */
export async function handleSkillsBundledRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname !== BUNDLED_PREFIX && !pathname.startsWith(`${BUNDLED_PREFIX}/`)) {
    return false;
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    sendText(res, 405, "Method Not Allowed");
    return true;
  }

  const authorized = await authorizeGatewayBearerRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    rateLimiter: opts.rateLimiter,
  });
  if (!authorized) {
    return true;
  }

  const manifest = loadManifest();
  if (!manifest.ok) {
    sendJson(res, 500, { error: { message: manifest.error, type: "server_error" } });
    return true;
  }

  // /skills/bundled — return full runtime envelope
  if (pathname === BUNDLED_PREFIX || pathname === `${BUNDLED_PREFIX}/`) {
    sendJson(res, 200, buildEnvelope(manifest.entries));
    return true;
  }

  // /skills/bundled/:name — return SKILL.md body.
  // Contract is exactly one safe path segment after the prefix. Extra
  // segments (including a trailing slash) are rejected as 404 rather than
  // matched against the leading segment — otherwise /skills/bundled/rain/foo
  // would serve `rain`'s body, masking client bugs.
  const subPath = pathname.slice(`${BUNDLED_PREFIX}/`.length);
  if (subPath.includes("/")) {
    sendJson(res, 404, { error: { message: "Skill not found", type: "not_found" } });
    return true;
  }
  const skillName = subPath;

  if (!skillName || !isSafeSkillName(skillName)) {
    sendJson(res, 404, { error: { message: "Skill not found", type: "not_found" } });
    return true;
  }

  // Ensure the skill exists in the manifest (canonical check before touching disk).
  const entry = manifest.entries.find((e) => e.name === skillName);
  if (!entry) {
    sendJson(res, 404, { error: { message: `Skill '${skillName}' not found`, type: "not_found" } });
    return true;
  }

  const skillFilePath = path.join(SKILLS_ROOT, skillName, "SKILL.md");
  // Verify the resolved path is strictly within SKILLS_ROOT (defense in depth).
  const resolved = path.resolve(skillFilePath);
  if (!resolved.startsWith(path.resolve(SKILLS_ROOT) + path.sep)) {
    sendJson(res, 404, { error: { message: "Skill not found", type: "not_found" } });
    return true;
  }

  if (!existsSync(skillFilePath)) {
    sendJson(res, 404, { error: { message: `Skill '${skillName}' not found`, type: "not_found" } });
    return true;
  }

  const body = readFileSync(skillFilePath, "utf8");
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.end(body);
  return true;
}
