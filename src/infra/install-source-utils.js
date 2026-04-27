import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import { fileExists, resolveArchiveKind } from "./archive.js";
export function buildNpmResolutionFields(resolution) {
    return {
        resolvedName: resolution?.name,
        resolvedVersion: resolution?.version,
        resolvedSpec: resolution?.resolvedSpec,
        integrity: resolution?.integrity,
        shasum: resolution?.shasum,
        resolvedAt: resolution?.resolvedAt,
    };
}
function normalizeNpmViewMetadata(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const rec = value;
    const name = toOptionalString(rec.name);
    const version = toOptionalString(rec.version);
    const resolvedSpec = name && version ? `${name}@${version}` : undefined;
    const dist = rec.dist && typeof rec.dist === "object" ? rec.dist : {};
    return {
        name,
        version,
        resolvedSpec,
        integrity: toOptionalString(rec["dist.integrity"]) ?? toOptionalString(dist.integrity),
        shasum: toOptionalString(rec["dist.shasum"]) ?? toOptionalString(dist.shasum),
    };
}
export async function resolveNpmSpecMetadata(params) {
    const res = await runCommandWithTimeout(["npm", "view", params.spec, "name", "version", "dist.integrity", "dist.shasum", "--json"], {
        timeoutMs: Math.max(params.timeoutMs ?? 60_000, 60_000),
        env: {
            COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
            NPM_CONFIG_IGNORE_SCRIPTS: "true",
        },
    });
    if (res.code !== 0) {
        const raw = res.stderr.trim() || res.stdout.trim();
        if (/E404|is not in this registry/i.test(raw)) {
            return {
                ok: false,
                error: `Package not found on npm: ${params.spec}. See https://docs.openclaw.ai/tools/plugin for installable plugins.`,
            };
        }
        return { ok: false, error: `npm view failed: ${raw}` };
    }
    try {
        const parsed = JSON.parse(res.stdout.trim());
        const metadata = normalizeNpmViewMetadata(parsed);
        if (!metadata?.name || !metadata.version) {
            return { ok: false, error: "npm view produced incomplete package metadata" };
        }
        return { ok: true, metadata };
    }
    catch (err) {
        return { ok: false, error: `npm view produced invalid JSON: ${String(err)}` };
    }
}
export async function withTempDir(prefix, fn) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
        return await fn(tmpDir);
    }
    finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
export async function resolveArchiveSourcePath(archivePath) {
    const resolved = resolveUserPath(archivePath);
    if (!(await fileExists(resolved))) {
        return { ok: false, error: `archive not found: ${resolved}` };
    }
    if (!resolveArchiveKind(resolved)) {
        return { ok: false, error: `unsupported archive: ${resolved}` };
    }
    return { ok: true, path: resolved };
}
function toOptionalString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function parseResolvedSpecFromId(id) {
    const at = id.lastIndexOf("@");
    if (at <= 0 || at >= id.length - 1) {
        return undefined;
    }
    const name = id.slice(0, at).trim();
    const version = id.slice(at + 1).trim();
    if (!name || !version) {
        return undefined;
    }
    return `${name}@${version}`;
}
function normalizeNpmPackEntry(entry) {
    if (!entry || typeof entry !== "object") {
        return null;
    }
    const rec = entry;
    const name = toOptionalString(rec.name);
    const version = toOptionalString(rec.version);
    const id = toOptionalString(rec.id);
    const resolvedSpec = (name && version ? `${name}@${version}` : undefined) ??
        (id ? parseResolvedSpecFromId(id) : undefined);
    return {
        filename: toOptionalString(rec.filename),
        metadata: {
            name,
            version,
            resolvedSpec,
            integrity: toOptionalString(rec.integrity),
            shasum: toOptionalString(rec.shasum),
        },
    };
}
function parseNpmPackJsonOutput(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }
    const candidates = [trimmed];
    const arrayStart = trimmed.indexOf("[");
    if (arrayStart > 0) {
        candidates.push(trimmed.slice(arrayStart));
    }
    for (const candidate of candidates) {
        let parsed;
        try {
            parsed = JSON.parse(candidate);
        }
        catch {
            continue;
        }
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        let fallback = null;
        for (let i = entries.length - 1; i >= 0; i -= 1) {
            const normalized = normalizeNpmPackEntry(entries[i]);
            if (!normalized) {
                continue;
            }
            if (!fallback) {
                fallback = normalized;
            }
            if (normalized.filename) {
                return normalized;
            }
        }
        if (fallback) {
            return fallback;
        }
    }
    return null;
}
function parsePackedArchiveFromStdout(stdout) {
    const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        const match = line?.match(/([^\s"']+\.tgz)/);
        if (match?.[1]) {
            return match[1];
        }
    }
    return undefined;
}
async function findPackedArchiveInDir(cwd) {
    const entries = await fs.readdir(cwd, { withFileTypes: true }).catch(() => []);
    const archives = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"));
    if (archives.length === 0) {
        return undefined;
    }
    if (archives.length === 1) {
        return archives[0]?.name;
    }
    const sortedByMtime = await Promise.all(archives.map(async (entry) => ({
        name: entry.name,
        mtimeMs: (await fs.stat(path.join(cwd, entry.name))).mtimeMs,
    })));
    sortedByMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return sortedByMtime[0]?.name;
}
export async function packNpmSpecToArchive(params) {
    const res = await runCommandWithTimeout(["npm", "pack", params.spec, "--ignore-scripts", "--json"], {
        timeoutMs: Math.max(params.timeoutMs, 300_000),
        cwd: params.cwd,
        env: {
            COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
            NPM_CONFIG_IGNORE_SCRIPTS: "true",
        },
    });
    if (res.code !== 0) {
        const raw = res.stderr.trim() || res.stdout.trim();
        if (/E404|is not in this registry/i.test(raw)) {
            return {
                ok: false,
                error: `Package not found on npm: ${params.spec}. See https://docs.openclaw.ai/tools/plugin for installable plugins.`,
            };
        }
        return { ok: false, error: `npm pack failed: ${raw}` };
    }
    const parsedJson = parseNpmPackJsonOutput(res.stdout || "");
    let packed = parsedJson?.filename ?? parsePackedArchiveFromStdout(res.stdout || "");
    if (!packed) {
        packed = await findPackedArchiveInDir(params.cwd);
    }
    if (!packed) {
        return { ok: false, error: "npm pack produced no archive" };
    }
    let archivePath = path.isAbsolute(packed) ? packed : path.join(params.cwd, packed);
    if (!(await fileExists(archivePath))) {
        const fallbackPacked = await findPackedArchiveInDir(params.cwd);
        if (!fallbackPacked) {
            return { ok: false, error: "npm pack produced no archive" };
        }
        archivePath = path.join(params.cwd, fallbackPacked);
    }
    return {
        ok: true,
        archivePath,
        metadata: parsedJson?.metadata ?? {},
    };
}
