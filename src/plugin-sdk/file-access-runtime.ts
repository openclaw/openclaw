// Safe local-file helpers for plugin runtime media and bridge code.

export { appendFileWithinRoot, readFileWithinRoot, writeFileWithinRoot } from "../infra/fs-safe.js";
export { basenameFromMediaSource, safeFileURLToPath } from "../infra/local-file-access.js";
