import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileFromPathWithinRoot } from "../infra/fs-safe.js";
import { sanitizeUntrustedFileName } from "./safe-filename.js";
function buildSiblingTempPath(targetPath) {
    const id = crypto.randomUUID();
    const safeTail = sanitizeUntrustedFileName(path.basename(targetPath), "output.bin");
    return path.join(path.dirname(targetPath), `.openclaw-output-${id}-${safeTail}.part`);
}
export async function writeViaSiblingTempPath(params) {
    const rootDir = path.resolve(params.rootDir);
    const targetPath = path.resolve(params.targetPath);
    const relativeTargetPath = path.relative(rootDir, targetPath);
    if (!relativeTargetPath ||
        relativeTargetPath === ".." ||
        relativeTargetPath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeTargetPath)) {
        throw new Error("Target path is outside the allowed root");
    }
    const tempPath = buildSiblingTempPath(targetPath);
    let renameSucceeded = false;
    try {
        await params.writeTemp(tempPath);
        await writeFileFromPathWithinRoot({
            rootDir,
            relativePath: relativeTargetPath,
            sourcePath: tempPath,
            mkdir: false,
        });
        renameSucceeded = true;
    }
    finally {
        if (!renameSucceeded) {
            await fs.rm(tempPath, { force: true }).catch(() => { });
        }
    }
}
