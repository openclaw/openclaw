import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveUserPath } from "../utils.js";
const CANVAS_DOCUMENTS_DIR_NAME = "documents";
function isPdfPathLike(value) {
    return /\.pdf(?:[?#].*)?$/i.test(value.trim());
}
function buildPdfWrapper(url) {
    const escaped = escapeHtml(url);
    return `<!doctype html><html><body style="margin:0;background:#e5e7eb;"><object data="${escaped}" type="application/pdf" style="width:100%;height:100vh;border:0;"><iframe src="${escaped}" style="width:100%;height:100vh;border:0;"></iframe><p style="padding:16px;font:14px system-ui,sans-serif;">Unable to render PDF preview. <a href="${escaped}" target="_blank" rel="noopener noreferrer">Open PDF</a>.</p></object></body></html>`;
}
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
function normalizeLogicalPath(value) {
    const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
        throw new Error("canvas document logicalPath invalid");
    }
    return parts.join("/");
}
function canvasDocumentId() {
    return `cv_${randomUUID().replaceAll("-", "")}`;
}
function normalizeCanvasDocumentId(value) {
    const normalized = value.trim();
    if (!normalized ||
        normalized === "." ||
        normalized === ".." ||
        !/^[A-Za-z0-9._-]+$/.test(normalized)) {
        throw new Error("canvas document id invalid");
    }
    return normalized;
}
export function resolveCanvasRootDir(rootDir, stateDir = resolveStateDir()) {
    const resolved = rootDir?.trim() ? resolveUserPath(rootDir) : path.join(stateDir, "canvas");
    return path.resolve(resolved);
}
export function resolveCanvasDocumentsDir(rootDir, stateDir = resolveStateDir()) {
    return path.join(resolveCanvasRootDir(rootDir, stateDir), CANVAS_DOCUMENTS_DIR_NAME);
}
export function resolveCanvasDocumentDir(documentId, options) {
    return path.join(resolveCanvasDocumentsDir(options?.rootDir, options?.stateDir), documentId);
}
export function buildCanvasDocumentEntryUrl(documentId, entrypoint) {
    const normalizedEntrypoint = normalizeLogicalPath(entrypoint);
    const encodedEntrypoint = normalizedEntrypoint
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
    return `${CANVAS_HOST_PATH}/${CANVAS_DOCUMENTS_DIR_NAME}/${encodeURIComponent(documentId)}/${encodedEntrypoint}`;
}
export function buildCanvasDocumentAssetUrl(documentId, logicalPath) {
    return buildCanvasDocumentEntryUrl(documentId, logicalPath);
}
export function resolveCanvasHttpPathToLocalPath(requestPath, options) {
    const trimmed = requestPath.trim();
    const prefix = `${CANVAS_HOST_PATH}/${CANVAS_DOCUMENTS_DIR_NAME}/`;
    if (!trimmed.startsWith(prefix)) {
        return null;
    }
    const pathWithoutQuery = trimmed.replace(/[?#].*$/, "");
    const relative = pathWithoutQuery.slice(prefix.length);
    const segments = relative
        .split("/")
        .map((segment) => {
        try {
            return decodeURIComponent(segment);
        }
        catch {
            return segment;
        }
    })
        .filter(Boolean);
    if (segments.length < 2) {
        return null;
    }
    const [rawDocumentId, ...entrySegments] = segments;
    try {
        const documentId = normalizeCanvasDocumentId(rawDocumentId);
        const normalizedEntrypoint = normalizeLogicalPath(entrySegments.join("/"));
        const documentsDir = path.resolve(resolveCanvasDocumentsDir(options?.rootDir, options?.stateDir));
        const candidatePath = path.resolve(resolveCanvasDocumentDir(documentId, options), normalizedEntrypoint);
        if (!(candidatePath === documentsDir || candidatePath.startsWith(`${documentsDir}${path.sep}`))) {
            return null;
        }
        return candidatePath;
    }
    catch {
        return null;
    }
}
async function writeManifest(rootDir, manifest) {
    await fs.writeFile(path.join(rootDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
async function copyAssets(rootDir, assets, workspaceDir) {
    const copied = [];
    for (const asset of assets ?? []) {
        const logicalPath = normalizeLogicalPath(asset.logicalPath);
        const sourcePath = asset.sourcePath.startsWith("~")
            ? resolveUserPath(asset.sourcePath)
            : path.isAbsolute(asset.sourcePath)
                ? path.resolve(asset.sourcePath)
                : path.resolve(workspaceDir, asset.sourcePath);
        const destination = path.join(rootDir, logicalPath);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(sourcePath, destination);
        copied.push({
            logicalPath,
            ...(asset.contentType ? { contentType: asset.contentType } : {}),
        });
    }
    return copied;
}
async function materializeEntrypoint(rootDir, input, workspaceDir) {
    const entrypoint = input.entrypoint;
    if (!entrypoint) {
        throw new Error("canvas document entrypoint required");
    }
    if (entrypoint.type === "html") {
        const fileName = "index.html";
        await fs.writeFile(path.join(rootDir, fileName), entrypoint.value, "utf8");
        return {
            localEntrypoint: fileName,
            entryUrl: buildCanvasDocumentEntryUrl(path.basename(rootDir), fileName),
        };
    }
    if (entrypoint.type === "url") {
        if (input.kind === "document" && isPdfPathLike(entrypoint.value)) {
            const fileName = "index.html";
            await fs.writeFile(path.join(rootDir, fileName), buildPdfWrapper(entrypoint.value), "utf8");
            return {
                localEntrypoint: fileName,
                externalUrl: entrypoint.value,
                entryUrl: buildCanvasDocumentEntryUrl(path.basename(rootDir), fileName),
            };
        }
        return {
            externalUrl: entrypoint.value,
            entryUrl: entrypoint.value,
        };
    }
    const resolvedPath = entrypoint.value.startsWith("~")
        ? resolveUserPath(entrypoint.value)
        : path.isAbsolute(entrypoint.value)
            ? path.resolve(entrypoint.value)
            : path.resolve(workspaceDir, entrypoint.value);
    if (input.kind === "image" || input.kind === "video_asset") {
        const copiedName = path.basename(resolvedPath);
        await fs.copyFile(resolvedPath, path.join(rootDir, copiedName));
        const wrapper = input.kind === "image"
            ? `<!doctype html><html><body style="margin:0;background:#0f172a;display:flex;align-items:center;justify-content:center;"><img src="${escapeHtml(copiedName)}" style="max-width:100%;max-height:100vh;object-fit:contain;" /></body></html>`
            : `<!doctype html><html><body style="margin:0;background:#0f172a;"><video src="${escapeHtml(copiedName)}" controls autoplay style="width:100%;height:100vh;object-fit:contain;background:#000;"></video></body></html>`;
        await fs.writeFile(path.join(rootDir, "index.html"), wrapper, "utf8");
        return {
            localEntrypoint: "index.html",
            entryUrl: buildCanvasDocumentEntryUrl(path.basename(rootDir), "index.html"),
        };
    }
    const fileName = path.basename(resolvedPath);
    await fs.copyFile(resolvedPath, path.join(rootDir, fileName));
    if (input.kind === "document" && isPdfPathLike(fileName)) {
        await fs.writeFile(path.join(rootDir, "index.html"), buildPdfWrapper(fileName), "utf8");
        return {
            localEntrypoint: "index.html",
            entryUrl: buildCanvasDocumentEntryUrl(path.basename(rootDir), "index.html"),
        };
    }
    return {
        localEntrypoint: fileName,
        entryUrl: buildCanvasDocumentEntryUrl(path.basename(rootDir), fileName),
    };
}
export async function createCanvasDocument(input, options) {
    const workspaceDir = options?.workspaceDir ?? process.cwd();
    const id = input.id?.trim() ? normalizeCanvasDocumentId(input.id) : canvasDocumentId();
    const rootDir = resolveCanvasDocumentDir(id, {
        stateDir: options?.stateDir,
        rootDir: options?.canvasRootDir,
    });
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.mkdir(rootDir, { recursive: true });
    const assets = await copyAssets(rootDir, input.assets, workspaceDir);
    const entry = await materializeEntrypoint(rootDir, input, workspaceDir);
    const manifest = {
        id,
        kind: input.kind,
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        ...(typeof input.preferredHeight === "number"
            ? { preferredHeight: input.preferredHeight }
            : {}),
        ...(input.surface ? { surface: input.surface } : {}),
        createdAt: new Date().toISOString(),
        entryUrl: entry.entryUrl,
        ...(entry.localEntrypoint ? { localEntrypoint: entry.localEntrypoint } : {}),
        ...(entry.externalUrl ? { externalUrl: entry.externalUrl } : {}),
        assets,
    };
    await writeManifest(rootDir, manifest);
    return manifest;
}
export async function loadCanvasDocumentManifest(documentId, options) {
    const id = normalizeCanvasDocumentId(documentId);
    const manifestPath = path.join(resolveCanvasDocumentDir(id, {
        stateDir: options?.stateDir,
        rootDir: options?.canvasRootDir,
    }), "manifest.json");
    try {
        const raw = await fs.readFile(manifestPath, "utf8");
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : null;
    }
    catch {
        return null;
    }
}
export function resolveCanvasDocumentAssets(manifest, options) {
    const baseUrl = options?.baseUrl?.trim().replace(/\/+$/, "");
    const documentDir = resolveCanvasDocumentDir(manifest.id, {
        stateDir: options?.stateDir,
        rootDir: options?.canvasRootDir,
    });
    return manifest.assets.map((asset) => ({
        logicalPath: asset.logicalPath,
        ...(asset.contentType ? { contentType: asset.contentType } : {}),
        localPath: path.join(documentDir, asset.logicalPath),
        url: baseUrl
            ? `${baseUrl}${buildCanvasDocumentAssetUrl(manifest.id, asset.logicalPath)}`
            : buildCanvasDocumentAssetUrl(manifest.id, asset.logicalPath),
    }));
}
