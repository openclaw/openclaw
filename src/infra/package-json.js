import fs from "node:fs/promises";
import path from "node:path";
export async function readPackageVersion(root) {
    try {
        const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
        const parsed = JSON.parse(raw);
        const version = parsed?.version?.trim();
        return version ? version : null;
    }
    catch {
        return null;
    }
}
export async function readPackageName(root) {
    try {
        const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
        const parsed = JSON.parse(raw);
        const name = parsed?.name?.trim();
        return name ? name : null;
    }
    catch {
        return null;
    }
}
