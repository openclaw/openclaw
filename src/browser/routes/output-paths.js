import fs from "node:fs/promises";
import { resolveWritablePathWithinRoot } from "./path-output.js";
export async function ensureOutputRootDir(rootDir) {
    await fs.mkdir(rootDir, { recursive: true });
}
export async function resolveWritableOutputPathOrRespond(params) {
    if (params.ensureRootDir) {
        await ensureOutputRootDir(params.rootDir);
    }
    const pathResult = await resolveWritablePathWithinRoot({
        rootDir: params.rootDir,
        requestedPath: params.requestedPath,
        scopeLabel: params.scopeLabel,
        defaultFileName: params.defaultFileName,
    });
    if (!pathResult.ok) {
        params.res.status(400).json({ error: pathResult.error });
        return null;
    }
    return pathResult.path;
}
