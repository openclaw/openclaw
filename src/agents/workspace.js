import syncFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openBoundaryFile } from "../infra/boundary-file-read.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { resolveWorkspaceTemplateDir } from "./workspace-templates.js";
export function resolveDefaultAgentWorkspaceDir(env = process.env, homedir = os.homedir) {
    const home = resolveRequiredHomeDir(env, homedir);
    const profile = env.OPENCLAW_PROFILE?.trim();
    if (profile && profile.toLowerCase() !== "default") {
        return path.join(home, ".openclaw", `workspace-${profile}`);
    }
    return path.join(home, ".openclaw", "workspace");
}
export const DEFAULT_AGENT_WORKSPACE_DIR = resolveDefaultAgentWorkspaceDir();
export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME = "USER.md";
export const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
export const DEFAULT_MEMORY_ALT_FILENAME = "memory.md";
const WORKSPACE_STATE_DIRNAME = ".openclaw";
const WORKSPACE_STATE_FILENAME = "workspace-state.json";
const WORKSPACE_STATE_VERSION = 1;
const workspaceTemplateCache = new Map();
let gitAvailabilityPromise = null;
const MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES = 2 * 1024 * 1024;
// File content cache keyed by stable file identity to avoid stale reads.
const workspaceFileCache = new Map();
function workspaceFileIdentity(stat, canonicalPath) {
    return `${canonicalPath}|${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}
async function readWorkspaceFileWithGuards(params) {
    const opened = await openBoundaryFile({
        absolutePath: params.filePath,
        rootPath: params.workspaceDir,
        boundaryLabel: "workspace root",
        maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
    });
    if (!opened.ok) {
        workspaceFileCache.delete(params.filePath);
        return opened;
    }
    const identity = workspaceFileIdentity(opened.stat, opened.path);
    const cached = workspaceFileCache.get(params.filePath);
    if (cached && cached.identity === identity) {
        syncFs.closeSync(opened.fd);
        return { ok: true, content: cached.content };
    }
    try {
        const content = syncFs.readFileSync(opened.fd, "utf-8");
        workspaceFileCache.set(params.filePath, { content, identity });
        return { ok: true, content };
    }
    catch (error) {
        workspaceFileCache.delete(params.filePath);
        return { ok: false, reason: "io", error };
    }
    finally {
        syncFs.closeSync(opened.fd);
    }
}
function stripFrontMatter(content) {
    if (!content.startsWith("---")) {
        return content;
    }
    const endIndex = content.indexOf("\n---", 3);
    if (endIndex === -1) {
        return content;
    }
    const start = endIndex + "\n---".length;
    let trimmed = content.slice(start);
    trimmed = trimmed.replace(/^\s+/, "");
    return trimmed;
}
async function loadTemplate(name) {
    const cached = workspaceTemplateCache.get(name);
    if (cached) {
        return cached;
    }
    const pending = (async () => {
        const templateDir = await resolveWorkspaceTemplateDir();
        const templatePath = path.join(templateDir, name);
        try {
            const content = await fs.readFile(templatePath, "utf-8");
            return stripFrontMatter(content);
        }
        catch {
            throw new Error(`Missing workspace template: ${name} (${templatePath}). Ensure docs/reference/templates are packaged.`);
        }
    })();
    workspaceTemplateCache.set(name, pending);
    try {
        return await pending;
    }
    catch (error) {
        workspaceTemplateCache.delete(name);
        throw error;
    }
}
/** Set of recognized bootstrap filenames for runtime validation */
const VALID_BOOTSTRAP_NAMES = new Set([
    DEFAULT_AGENTS_FILENAME,
    DEFAULT_SOUL_FILENAME,
    DEFAULT_TOOLS_FILENAME,
    DEFAULT_IDENTITY_FILENAME,
    DEFAULT_USER_FILENAME,
    DEFAULT_HEARTBEAT_FILENAME,
    DEFAULT_BOOTSTRAP_FILENAME,
    DEFAULT_MEMORY_FILENAME,
    DEFAULT_MEMORY_ALT_FILENAME,
]);
async function writeFileIfMissing(filePath, content) {
    try {
        await fs.writeFile(filePath, content, {
            encoding: "utf-8",
            flag: "wx",
        });
        return true;
    }
    catch (err) {
        const anyErr = err;
        if (anyErr.code !== "EEXIST") {
            throw err;
        }
        return false;
    }
}
async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
function resolveWorkspaceStatePath(dir) {
    return path.join(dir, WORKSPACE_STATE_DIRNAME, WORKSPACE_STATE_FILENAME);
}
function parseWorkspaceOnboardingState(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") {
            return null;
        }
        return {
            version: WORKSPACE_STATE_VERSION,
            bootstrapSeededAt: typeof parsed.bootstrapSeededAt === "string" ? parsed.bootstrapSeededAt : undefined,
            onboardingCompletedAt: typeof parsed.onboardingCompletedAt === "string" ? parsed.onboardingCompletedAt : undefined,
        };
    }
    catch {
        return null;
    }
}
async function readWorkspaceOnboardingState(statePath) {
    try {
        const raw = await fs.readFile(statePath, "utf-8");
        return (parseWorkspaceOnboardingState(raw) ?? {
            version: WORKSPACE_STATE_VERSION,
        });
    }
    catch (err) {
        const anyErr = err;
        if (anyErr.code !== "ENOENT") {
            throw err;
        }
        return {
            version: WORKSPACE_STATE_VERSION,
        };
    }
}
async function readWorkspaceOnboardingStateForDir(dir) {
    const statePath = resolveWorkspaceStatePath(resolveUserPath(dir));
    return await readWorkspaceOnboardingState(statePath);
}
export async function isWorkspaceOnboardingCompleted(dir) {
    const state = await readWorkspaceOnboardingStateForDir(dir);
    return (typeof state.onboardingCompletedAt === "string" && state.onboardingCompletedAt.trim().length > 0);
}
async function writeWorkspaceOnboardingState(statePath, state) {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
    try {
        await fs.writeFile(tmpPath, payload, { encoding: "utf-8" });
        await fs.rename(tmpPath, statePath);
    }
    catch (err) {
        await fs.unlink(tmpPath).catch(() => { });
        throw err;
    }
}
async function hasGitRepo(dir) {
    try {
        await fs.stat(path.join(dir, ".git"));
        return true;
    }
    catch {
        return false;
    }
}
async function isGitAvailable() {
    if (gitAvailabilityPromise) {
        return gitAvailabilityPromise;
    }
    gitAvailabilityPromise = (async () => {
        try {
            const result = await runCommandWithTimeout(["git", "--version"], { timeoutMs: 2000 });
            return result.code === 0;
        }
        catch {
            return false;
        }
    })();
    return gitAvailabilityPromise;
}
async function ensureGitRepo(dir, isBrandNewWorkspace) {
    if (!isBrandNewWorkspace) {
        return;
    }
    if (await hasGitRepo(dir)) {
        return;
    }
    if (!(await isGitAvailable())) {
        return;
    }
    try {
        await runCommandWithTimeout(["git", "init"], { cwd: dir, timeoutMs: 10000 });
    }
    catch {
        // Ignore git init failures; workspace creation should still succeed.
    }
}
export async function ensureAgentWorkspace(params) {
    const rawDir = params?.dir?.trim() ? params.dir.trim() : DEFAULT_AGENT_WORKSPACE_DIR;
    const dir = resolveUserPath(rawDir);
    await fs.mkdir(dir, { recursive: true });
    if (!params?.ensureBootstrapFiles) {
        return { dir };
    }
    const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
    const soulPath = path.join(dir, DEFAULT_SOUL_FILENAME);
    const toolsPath = path.join(dir, DEFAULT_TOOLS_FILENAME);
    const identityPath = path.join(dir, DEFAULT_IDENTITY_FILENAME);
    const userPath = path.join(dir, DEFAULT_USER_FILENAME);
    const heartbeatPath = path.join(dir, DEFAULT_HEARTBEAT_FILENAME);
    const bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);
    const statePath = resolveWorkspaceStatePath(dir);
    const isBrandNewWorkspace = await (async () => {
        const templatePaths = [agentsPath, soulPath, toolsPath, identityPath, userPath, heartbeatPath];
        const userContentPaths = [
            path.join(dir, "memory"),
            path.join(dir, DEFAULT_MEMORY_FILENAME),
            path.join(dir, ".git"),
        ];
        const paths = [...templatePaths, ...userContentPaths];
        const existing = await Promise.all(paths.map(async (p) => {
            try {
                await fs.access(p);
                return true;
            }
            catch {
                return false;
            }
        }));
        return existing.every((v) => !v);
    })();
    const agentsTemplate = await loadTemplate(DEFAULT_AGENTS_FILENAME);
    const soulTemplate = await loadTemplate(DEFAULT_SOUL_FILENAME);
    const toolsTemplate = await loadTemplate(DEFAULT_TOOLS_FILENAME);
    const identityTemplate = await loadTemplate(DEFAULT_IDENTITY_FILENAME);
    const userTemplate = await loadTemplate(DEFAULT_USER_FILENAME);
    const heartbeatTemplate = await loadTemplate(DEFAULT_HEARTBEAT_FILENAME);
    await writeFileIfMissing(agentsPath, agentsTemplate);
    await writeFileIfMissing(soulPath, soulTemplate);
    await writeFileIfMissing(toolsPath, toolsTemplate);
    await writeFileIfMissing(identityPath, identityTemplate);
    await writeFileIfMissing(userPath, userTemplate);
    await writeFileIfMissing(heartbeatPath, heartbeatTemplate);
    let state = await readWorkspaceOnboardingState(statePath);
    let stateDirty = false;
    const markState = (next) => {
        state = { ...state, ...next };
        stateDirty = true;
    };
    const nowIso = () => new Date().toISOString();
    let bootstrapExists = await fileExists(bootstrapPath);
    if (!state.bootstrapSeededAt && bootstrapExists) {
        markState({ bootstrapSeededAt: nowIso() });
    }
    if (!state.onboardingCompletedAt && state.bootstrapSeededAt && !bootstrapExists) {
        markState({ onboardingCompletedAt: nowIso() });
    }
    if (!state.bootstrapSeededAt && !state.onboardingCompletedAt && !bootstrapExists) {
        // Legacy migration path: if USER/IDENTITY diverged from templates, or if user-content
        // indicators exist, treat onboarding as complete and avoid recreating BOOTSTRAP for
        // already-onboarded workspaces.
        const [identityContent, userContent] = await Promise.all([
            fs.readFile(identityPath, "utf-8"),
            fs.readFile(userPath, "utf-8"),
        ]);
        const hasUserContent = await (async () => {
            const indicators = [
                path.join(dir, "memory"),
                path.join(dir, DEFAULT_MEMORY_FILENAME),
                path.join(dir, ".git"),
            ];
            for (const indicator of indicators) {
                try {
                    await fs.access(indicator);
                    return true;
                }
                catch {
                    // continue
                }
            }
            return false;
        })();
        const legacyOnboardingCompleted = identityContent !== identityTemplate || userContent !== userTemplate || hasUserContent;
        if (legacyOnboardingCompleted) {
            markState({ onboardingCompletedAt: nowIso() });
        }
        else {
            const bootstrapTemplate = await loadTemplate(DEFAULT_BOOTSTRAP_FILENAME);
            const wroteBootstrap = await writeFileIfMissing(bootstrapPath, bootstrapTemplate);
            if (!wroteBootstrap) {
                bootstrapExists = await fileExists(bootstrapPath);
            }
            else {
                bootstrapExists = true;
            }
            if (bootstrapExists && !state.bootstrapSeededAt) {
                markState({ bootstrapSeededAt: nowIso() });
            }
        }
    }
    if (stateDirty) {
        await writeWorkspaceOnboardingState(statePath, state);
    }
    await ensureGitRepo(dir, isBrandNewWorkspace);
    return {
        dir,
        agentsPath,
        soulPath,
        toolsPath,
        identityPath,
        userPath,
        heartbeatPath,
        bootstrapPath,
    };
}
async function resolveMemoryBootstrapEntries(resolvedDir) {
    const candidates = [
        DEFAULT_MEMORY_FILENAME,
        DEFAULT_MEMORY_ALT_FILENAME,
    ];
    const entries = [];
    for (const name of candidates) {
        const filePath = path.join(resolvedDir, name);
        try {
            await fs.access(filePath);
            entries.push({ name, filePath });
        }
        catch {
            // optional
        }
    }
    if (entries.length <= 1) {
        return entries;
    }
    const seen = new Set();
    const deduped = [];
    for (const entry of entries) {
        let key = entry.filePath;
        try {
            key = await fs.realpath(entry.filePath);
        }
        catch { }
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(entry);
    }
    return deduped;
}
export async function loadWorkspaceBootstrapFiles(dir) {
    const resolvedDir = resolveUserPath(dir);
    const entries = [
        {
            name: DEFAULT_AGENTS_FILENAME,
            filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME),
        },
        {
            name: DEFAULT_SOUL_FILENAME,
            filePath: path.join(resolvedDir, DEFAULT_SOUL_FILENAME),
        },
        {
            name: DEFAULT_TOOLS_FILENAME,
            filePath: path.join(resolvedDir, DEFAULT_TOOLS_FILENAME),
        },
        {
            name: DEFAULT_IDENTITY_FILENAME,
            filePath: path.join(resolvedDir, DEFAULT_IDENTITY_FILENAME),
        },
        {
            name: DEFAULT_USER_FILENAME,
            filePath: path.join(resolvedDir, DEFAULT_USER_FILENAME),
        },
        {
            name: DEFAULT_HEARTBEAT_FILENAME,
            filePath: path.join(resolvedDir, DEFAULT_HEARTBEAT_FILENAME),
        },
        {
            name: DEFAULT_BOOTSTRAP_FILENAME,
            filePath: path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME),
        },
    ];
    entries.push(...(await resolveMemoryBootstrapEntries(resolvedDir)));
    const result = [];
    for (const entry of entries) {
        const loaded = await readWorkspaceFileWithGuards({
            filePath: entry.filePath,
            workspaceDir: resolvedDir,
        });
        if (loaded.ok) {
            result.push({
                name: entry.name,
                path: entry.filePath,
                content: loaded.content,
                missing: false,
            });
        }
        else {
            result.push({ name: entry.name, path: entry.filePath, missing: true });
        }
    }
    return result;
}
const MINIMAL_BOOTSTRAP_ALLOWLIST = new Set([
    DEFAULT_AGENTS_FILENAME,
    DEFAULT_TOOLS_FILENAME,
    DEFAULT_SOUL_FILENAME,
    DEFAULT_IDENTITY_FILENAME,
    DEFAULT_USER_FILENAME,
]);
export function filterBootstrapFilesForSession(files, sessionKey) {
    if (!sessionKey || (!isSubagentSessionKey(sessionKey) && !isCronSessionKey(sessionKey))) {
        return files;
    }
    return files.filter((file) => MINIMAL_BOOTSTRAP_ALLOWLIST.has(file.name));
}
export async function loadExtraBootstrapFiles(dir, extraPatterns) {
    const loaded = await loadExtraBootstrapFilesWithDiagnostics(dir, extraPatterns);
    return loaded.files;
}
export async function loadExtraBootstrapFilesWithDiagnostics(dir, extraPatterns) {
    if (!extraPatterns.length) {
        return { files: [], diagnostics: [] };
    }
    const resolvedDir = resolveUserPath(dir);
    // Resolve glob patterns into concrete file paths
    const resolvedPaths = new Set();
    for (const pattern of extraPatterns) {
        if (pattern.includes("*") || pattern.includes("?") || pattern.includes("{")) {
            try {
                const matches = fs.glob(pattern, { cwd: resolvedDir });
                for await (const m of matches) {
                    resolvedPaths.add(m);
                }
            }
            catch {
                // glob not available or pattern error — fall back to literal
                resolvedPaths.add(pattern);
            }
        }
        else {
            resolvedPaths.add(pattern);
        }
    }
    const files = [];
    const diagnostics = [];
    for (const relPath of resolvedPaths) {
        const filePath = path.resolve(resolvedDir, relPath);
        // Only load files whose basename is a recognized bootstrap filename
        const baseName = path.basename(relPath);
        if (!VALID_BOOTSTRAP_NAMES.has(baseName)) {
            diagnostics.push({
                path: filePath,
                reason: "invalid-bootstrap-filename",
                detail: `unsupported bootstrap basename: ${baseName}`,
            });
            continue;
        }
        const loaded = await readWorkspaceFileWithGuards({
            filePath,
            workspaceDir: resolvedDir,
        });
        if (loaded.ok) {
            files.push({
                name: baseName,
                path: filePath,
                content: loaded.content,
                missing: false,
            });
            continue;
        }
        const reason = loaded.reason === "path" ? "missing" : loaded.reason === "validation" ? "security" : "io";
        diagnostics.push({
            path: filePath,
            reason,
            detail: loaded.error instanceof Error
                ? loaded.error.message
                : typeof loaded.error === "string"
                    ? loaded.error
                    : reason,
        });
    }
    return { files, diagnostics };
}
