import fs from "node:fs/promises";
export function isFileMissingError(err) {
    return Boolean(err &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "ENOENT");
}
export async function statRegularFile(absPath) {
    let stat;
    try {
        stat = await fs.lstat(absPath);
    }
    catch (err) {
        if (isFileMissingError(err)) {
            return { missing: true };
        }
        throw err;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("path required");
    }
    return { missing: false, stat };
}
