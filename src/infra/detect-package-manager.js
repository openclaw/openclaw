import fs from "node:fs/promises";
import path from "node:path";
export async function detectPackageManager(root) {
    try {
        const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
        const parsed = JSON.parse(raw);
        const pm = parsed?.packageManager?.split("@")[0]?.trim();
        if (pm === "pnpm" || pm === "bun" || pm === "npm") {
            return pm;
        }
    }
    catch {
        // ignore
    }
    const files = await fs.readdir(root).catch(() => []);
    if (files.includes("pnpm-lock.yaml")) {
        return "pnpm";
    }
    if (files.includes("bun.lock") || files.includes("bun.lockb")) {
        return "bun";
    }
    if (files.includes("package-lock.json")) {
        return "npm";
    }
    return null;
}
