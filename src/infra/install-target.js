import fs from "node:fs/promises";
import { fileExists } from "./archive.js";
import { formatErrorMessage } from "./errors.js";
import { assertCanonicalPathWithinBase, resolveSafeInstallDir } from "./install-safe-path.js";
export async function resolveCanonicalInstallTarget(params) {
    await fs.mkdir(params.baseDir, { recursive: true });
    const targetDirResult = resolveSafeInstallDir({
        baseDir: params.baseDir,
        id: params.id,
        invalidNameMessage: params.invalidNameMessage,
        nameEncoder: params.nameEncoder,
    });
    if (!targetDirResult.ok) {
        return { ok: false, error: targetDirResult.error };
    }
    try {
        await assertCanonicalPathWithinBase({
            baseDir: params.baseDir,
            candidatePath: targetDirResult.path,
            boundaryLabel: params.boundaryLabel,
        });
    }
    catch (err) {
        return { ok: false, error: formatErrorMessage(err) };
    }
    return { ok: true, targetDir: targetDirResult.path };
}
export async function ensureInstallTargetAvailable(params) {
    if (params.mode === "install" && (await fileExists(params.targetDir))) {
        return { ok: false, error: params.alreadyExistsError };
    }
    return { ok: true };
}
