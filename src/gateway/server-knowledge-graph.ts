import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";

const GRAPH_PATH_PREFIX = "/api/knowledge-graph/";

export function handleKnowledgeGraphHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    workspaceDir: string | undefined,
): boolean {
    if (!workspaceDir) {
        return false;
    }

    const urlRaw = req.url;
    if (!urlRaw || !urlRaw.startsWith(GRAPH_PATH_PREFIX)) {
        return false;
    }

    const relPath = urlRaw.slice(GRAPH_PATH_PREFIX.length);
    if (!relPath || relPath.includes("..") || relPath.startsWith("/") || relPath.includes("\0")) {
        res.statusCode = 400;
        res.end("Invalid path");
        return true;
    }

    const skillDir = path.join(workspaceDir, "skills", "knowledge-graph");
    const filePath = path.join(skillDir, relPath);

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.statusCode = 404;
        res.end("Not Found");
        return true;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = contentTypeForExt(ext);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-cache");
    res.end(fs.readFileSync(filePath));
    return true;
}

function contentTypeForExt(ext: string): string {
    switch (ext) {
        case ".html":
            return "text/html; charset=utf-8";
        case ".js":
            return "application/javascript; charset=utf-8";
        case ".css":
            return "text/css; charset=utf-8";
        case ".json":
            return "application/json; charset=utf-8";
        case ".svg":
            return "image/svg+xml";
        case ".png":
            return "image/png";
        default:
            return "application/octet-stream";
    }
}
