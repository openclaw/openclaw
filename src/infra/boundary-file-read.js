import fs from "node:fs";
import path from "node:path";
import { resolveBoundaryPath, resolveBoundaryPathSync, } from "./boundary-path.js";
import { openVerifiedFileSync, } from "./safe-open-sync.js";
export function canUseBoundaryFileOpen(ioFs) {
    return (typeof ioFs.openSync === "function" &&
        typeof ioFs.closeSync === "function" &&
        typeof ioFs.fstatSync === "function" &&
        typeof ioFs.lstatSync === "function" &&
        typeof ioFs.realpathSync === "function" &&
        typeof ioFs.readFileSync === "function" &&
        typeof ioFs.constants === "object" &&
        ioFs.constants !== null);
}
export function openBoundaryFileSync(params) {
    const ioFs = params.ioFs ?? fs;
    const resolved = resolveBoundaryFilePathGeneric({
        absolutePath: params.absolutePath,
        resolve: (absolutePath) => resolveBoundaryPathSync({
            absolutePath,
            rootPath: params.rootPath,
            rootCanonicalPath: params.rootRealPath,
            boundaryLabel: params.boundaryLabel,
            skipLexicalRootCheck: params.skipLexicalRootCheck,
        }),
    });
    if (resolved instanceof Promise) {
        return toBoundaryValidationError(new Error("Unexpected async boundary resolution"));
    }
    if ("ok" in resolved) {
        return resolved;
    }
    return openBoundaryFileResolved({
        absolutePath: resolved.absolutePath,
        resolvedPath: resolved.resolvedPath,
        rootRealPath: resolved.rootRealPath,
        maxBytes: params.maxBytes,
        rejectHardlinks: params.rejectHardlinks,
        allowedType: params.allowedType,
        ioFs,
    });
}
function openBoundaryFileResolved(params) {
    const opened = openVerifiedFileSync({
        filePath: params.absolutePath,
        resolvedPath: params.resolvedPath,
        rejectHardlinks: params.rejectHardlinks ?? true,
        maxBytes: params.maxBytes,
        allowedType: params.allowedType,
        ioFs: params.ioFs,
    });
    if (!opened.ok) {
        return opened;
    }
    return {
        ok: true,
        path: opened.path,
        fd: opened.fd,
        stat: opened.stat,
        rootRealPath: params.rootRealPath,
    };
}
export async function openBoundaryFile(params) {
    const ioFs = params.ioFs ?? fs;
    const maybeResolved = resolveBoundaryFilePathGeneric({
        absolutePath: params.absolutePath,
        resolve: (absolutePath) => resolveBoundaryPath({
            absolutePath,
            rootPath: params.rootPath,
            rootCanonicalPath: params.rootRealPath,
            boundaryLabel: params.boundaryLabel,
            policy: params.aliasPolicy,
            skipLexicalRootCheck: params.skipLexicalRootCheck,
        }),
    });
    const resolved = maybeResolved instanceof Promise ? await maybeResolved : maybeResolved;
    if ("ok" in resolved) {
        return resolved;
    }
    return openBoundaryFileResolved({
        absolutePath: resolved.absolutePath,
        resolvedPath: resolved.resolvedPath,
        rootRealPath: resolved.rootRealPath,
        maxBytes: params.maxBytes,
        rejectHardlinks: params.rejectHardlinks,
        allowedType: params.allowedType,
        ioFs,
    });
}
function toBoundaryValidationError(error) {
    return { ok: false, reason: "validation", error };
}
function mapResolvedBoundaryPath(absolutePath, resolved) {
    return {
        absolutePath,
        resolvedPath: resolved.canonicalPath,
        rootRealPath: resolved.rootCanonicalPath,
    };
}
function resolveBoundaryFilePathGeneric(params) {
    const absolutePath = path.resolve(params.absolutePath);
    try {
        const resolved = params.resolve(absolutePath);
        if (resolved instanceof Promise) {
            return resolved
                .then((value) => mapResolvedBoundaryPath(absolutePath, value))
                .catch((error) => toBoundaryValidationError(error));
        }
        return mapResolvedBoundaryPath(absolutePath, resolved);
    }
    catch (error) {
        return toBoundaryValidationError(error);
    }
}
