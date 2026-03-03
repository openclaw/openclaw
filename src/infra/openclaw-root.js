import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const CORE_PACKAGE_NAMES = new Set(["openclaw"]);
async function readPackageName(dir) {
    try {
        const raw = await fs.readFile(path.join(dir, "package.json"), "utf-8");
        const parsed = JSON.parse(raw);
        return typeof parsed.name === "string" ? parsed.name : null;
    }
    catch {
        return null;
    }
}
function readPackageNameSync(dir) {
    try {
        const raw = fsSync.readFileSync(path.join(dir, "package.json"), "utf-8");
        const parsed = JSON.parse(raw);
        return typeof parsed.name === "string" ? parsed.name : null;
    }
    catch {
        return null;
    }
}
async function findPackageRoot(startDir, maxDepth = 12) {
    for (const current of iterAncestorDirs(startDir, maxDepth)) {
        const name = await readPackageName(current);
        if (name && CORE_PACKAGE_NAMES.has(name)) {
            return current;
        }
    }
    return null;
}
function findPackageRootSync(startDir, maxDepth = 12) {
    for (const current of iterAncestorDirs(startDir, maxDepth)) {
        const name = readPackageNameSync(current);
        if (name && CORE_PACKAGE_NAMES.has(name)) {
            return current;
        }
    }
    return null;
}
function* iterAncestorDirs(startDir, maxDepth) {
    let current = path.resolve(startDir);
    for (let i = 0; i < maxDepth; i += 1) {
        yield current;
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
}
function candidateDirsFromArgv1(argv1) {
    const normalized = path.resolve(argv1);
    const candidates = [path.dirname(normalized)];
    // Resolve symlinks for version managers (nvm, fnm, n, Homebrew/Linuxbrew)
    // that create symlinks in bin/ pointing to the real package location.
    try {
        const resolved = fsSync.realpathSync(normalized);
        if (resolved !== normalized) {
            candidates.push(path.dirname(resolved));
        }
    }
    catch {
        // realpathSync throws if path doesn't exist; keep original candidates
    }
    const parts = normalized.split(path.sep);
    const binIndex = parts.lastIndexOf(".bin");
    if (binIndex > 0 && parts[binIndex - 1] === "node_modules") {
        const binName = path.basename(normalized);
        const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
        candidates.push(path.join(nodeModulesDir, binName));
    }
    return candidates;
}
export async function resolveOpenClawPackageRoot(opts) {
    for (const candidate of buildCandidates(opts)) {
        const found = await findPackageRoot(candidate);
        if (found) {
            return found;
        }
    }
    return null;
}
export function resolveOpenClawPackageRootSync(opts) {
    for (const candidate of buildCandidates(opts)) {
        const found = findPackageRootSync(candidate);
        if (found) {
            return found;
        }
    }
    return null;
}
function buildCandidates(opts) {
    const candidates = [];
    if (opts.moduleUrl) {
        candidates.push(path.dirname(fileURLToPath(opts.moduleUrl)));
    }
    if (opts.argv1) {
        candidates.push(...candidateDirsFromArgv1(opts.argv1));
    }
    if (opts.cwd) {
        candidates.push(opts.cwd);
    }
    return candidates;
}
