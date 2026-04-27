import fs from "node:fs/promises";
import path from "node:path";
import { copyFileWithinRoot } from "./fs-safe.js";
import { isNotFoundPathError, isPathInside } from "./path-guards.js";
const ERROR_ARCHIVE_ENTRY_TRAVERSES_SYMLINK = "archive entry traverses symlink in destination";
export class ArchiveSecurityError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = "ArchiveSecurityError";
    }
}
function symlinkTraversalError(originalPath) {
    return new ArchiveSecurityError("destination-symlink-traversal", `${ERROR_ARCHIVE_ENTRY_TRAVERSES_SYMLINK}: ${originalPath}`);
}
export async function prepareArchiveDestinationDir(destDir) {
    const stat = await fs.lstat(destDir);
    if (stat.isSymbolicLink()) {
        throw new ArchiveSecurityError("destination-symlink", "archive destination is a symlink");
    }
    if (!stat.isDirectory()) {
        throw new ArchiveSecurityError("destination-not-directory", "archive destination is not a directory");
    }
    return await fs.realpath(destDir);
}
async function assertNoSymlinkTraversal(params) {
    const parts = params.relPath.split(/[\\/]+/).filter(Boolean);
    let current = path.resolve(params.rootDir);
    for (const part of parts) {
        current = path.join(current, part);
        let stat;
        try {
            stat = await fs.lstat(current);
        }
        catch (err) {
            if (isNotFoundPathError(err)) {
                continue;
            }
            throw err;
        }
        if (stat.isSymbolicLink()) {
            throw symlinkTraversalError(params.originalPath);
        }
    }
}
async function assertResolvedInsideDestination(params) {
    let resolved;
    try {
        resolved = await fs.realpath(params.targetPath);
    }
    catch (err) {
        if (isNotFoundPathError(err)) {
            return;
        }
        throw err;
    }
    if (!isPathInside(params.destinationRealDir, resolved)) {
        throw symlinkTraversalError(params.originalPath);
    }
}
export async function prepareArchiveOutputPath(params) {
    await assertNoSymlinkTraversal({
        rootDir: params.destinationDir,
        relPath: params.relPath,
        originalPath: params.originalPath,
    });
    if (params.isDirectory) {
        await fs.mkdir(params.outPath, { recursive: true });
        await assertResolvedInsideDestination({
            destinationRealDir: params.destinationRealDir,
            targetPath: params.outPath,
            originalPath: params.originalPath,
        });
        return;
    }
    const parentDir = path.dirname(params.outPath);
    await fs.mkdir(parentDir, { recursive: true });
    await assertResolvedInsideDestination({
        destinationRealDir: params.destinationRealDir,
        targetPath: parentDir,
        originalPath: params.originalPath,
    });
}
async function applyStagedEntryMode(params) {
    const destinationPath = path.join(params.destinationRealDir, params.relPath);
    await assertResolvedInsideDestination({
        destinationRealDir: params.destinationRealDir,
        targetPath: destinationPath,
        originalPath: params.originalPath,
    });
    if (params.mode !== 0) {
        await fs.chmod(destinationPath, params.mode).catch(() => undefined);
    }
}
export async function withStagedArchiveDestination(params) {
    const stagingDir = await fs.mkdtemp(path.join(params.destinationRealDir, ".openclaw-archive-"));
    try {
        return await params.run(stagingDir);
    }
    finally {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
export async function mergeExtractedTreeIntoDestination(params) {
    const walk = async (currentSourceDir) => {
        const entries = await fs.readdir(currentSourceDir, { withFileTypes: true });
        for (const entry of entries) {
            const sourcePath = path.join(currentSourceDir, entry.name);
            const relPath = path.relative(params.sourceDir, sourcePath);
            const originalPath = relPath.split(path.sep).join("/");
            const destinationPath = path.join(params.destinationDir, relPath);
            const sourceStat = await fs.lstat(sourcePath);
            if (sourceStat.isSymbolicLink()) {
                throw symlinkTraversalError(originalPath);
            }
            if (sourceStat.isDirectory()) {
                await prepareArchiveOutputPath({
                    destinationDir: params.destinationDir,
                    destinationRealDir: params.destinationRealDir,
                    relPath,
                    outPath: destinationPath,
                    originalPath,
                    isDirectory: true,
                });
                await walk(sourcePath);
                await applyStagedEntryMode({
                    destinationRealDir: params.destinationRealDir,
                    relPath,
                    mode: sourceStat.mode & 0o777,
                    originalPath,
                });
                continue;
            }
            if (!sourceStat.isFile()) {
                throw new Error(`archive staging contains unsupported entry: ${originalPath}`);
            }
            await prepareArchiveOutputPath({
                destinationDir: params.destinationDir,
                destinationRealDir: params.destinationRealDir,
                relPath,
                outPath: destinationPath,
                originalPath,
                isDirectory: false,
            });
            await copyFileWithinRoot({
                sourcePath,
                rootDir: params.destinationRealDir,
                relativePath: relPath,
                mkdir: true,
            });
            await applyStagedEntryMode({
                destinationRealDir: params.destinationRealDir,
                relPath,
                mode: sourceStat.mode & 0o777,
                originalPath,
            });
        }
    };
    await walk(params.sourceDir);
}
export function createArchiveSymlinkTraversalError(originalPath) {
    return symlinkTraversalError(originalPath);
}
