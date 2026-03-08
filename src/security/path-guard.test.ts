import { describe, expect, it, vi, beforeEach } from "vitest";
import { checkPathGuardStrict, PathGuardError } from "./path-guard.js";
import fs from "node:fs/promises";
import path from "node:path";

// Mock fs to simulate realpath and other behaviors
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
        ...actual,
        realpath: vi.fn(),
    };
});

describe("PathGuard Exhaustive Tests", () => {
    const workspaceRoot = "/workspace";
    const realWorkspaceRoot = "/real/workspace";

    beforeEach(() => {
        vi.resetAllMocks();
        // Default: workspace root resolves to real path
        (fs.realpath as any).mockImplementation((p: string) => {
            const normalized = path.resolve(p).replace(/\\/g, "/");
            if (normalized === path.resolve(workspaceRoot).replace(/\\/g, "/")) return Promise.resolve(realWorkspaceRoot);
            return Promise.resolve(normalized); // Default fallback
        });
    });

    it("allows access inside workspace when workspaceOnly is true", async () => {
        const requested = path.join(workspaceRoot, "src/index.ts");
        const resolved = path.join(realWorkspaceRoot, "src/index.ts");

        (fs.realpath as any).mockImplementation((p: string) => {
            const normalized = path.resolve(p).replace(/\\/g, "/");
            if (normalized === path.resolve(workspaceRoot).replace(/\\/g, "/")) return Promise.resolve(realWorkspaceRoot);
            if (normalized === path.resolve(requested).replace(/\\/g, "/")) return Promise.resolve(resolved);
            return Promise.resolve(normalized);
        });

        const result = await checkPathGuardStrict(requested, { workspaceOnly: true }, workspaceRoot);
        expect(result).toBe(resolved);
    });

    it("denies access outside workspace when workspaceOnly is true", async () => {
        const requested = "/etc/passwd";
        await expect(
            checkPathGuardStrict(requested, { workspaceOnly: true }, workspaceRoot)
        ).rejects.toThrow(PathGuardError);
    });

    it("denies access via chained symlinks escaping workspace", async () => {
        // a -> b -> /etc/passwd
        const linkA = path.join(workspaceRoot, "linkA");
        const linkB = path.join(workspaceRoot, "linkB");
        const target = "/etc/passwd";

        (fs.realpath as any).mockImplementation((p: string) => {
            const normalized = path.resolve(p).replace(/\\/g, "/");
            if (normalized === path.resolve(workspaceRoot).replace(/\\/g, "/")) return Promise.resolve(realWorkspaceRoot);
            if (normalized === path.resolve(linkA).replace(/\\/g, "/")) return Promise.resolve(linkB);
            if (normalized === path.resolve(linkB).replace(/\\/g, "/")) return Promise.resolve(target);
            return Promise.resolve(normalized);
        });

        await expect(
            checkPathGuardStrict(linkA, { workspaceOnly: true }, workspaceRoot)
        ).rejects.toThrow(/outside the workspace root/);
    });

    it("denies access to a new file in a symlinked parent that escapes (multi-level)", async () => {
        // workspace/folder_link -> /data/external
        // /data/external is outside workspace
        const requested = path.join(workspaceRoot, "folder_link/new_file.txt");
        const externalDir = "/data/external";
        const resolved = "/data/external/new_file.txt";

        (fs.realpath as any).mockImplementation((p: string) => {
            const normalized = path.resolve(p).replace(/\\/g, "/");
            if (normalized === path.resolve(workspaceRoot).replace(/\\/g, "/")) return Promise.resolve(realWorkspaceRoot);
            if (normalized === path.resolve(path.join(workspaceRoot, "folder_link")).replace(/\\/g, "/")) return Promise.resolve(externalDir);
            if (normalized === path.resolve(requested).replace(/\\/g, "/")) {
                const err = new Error("ENOENT");
                (err as any).code = "ENOENT";
                throw err;
            }
            return Promise.resolve(normalized);
        });

        await expect(
            checkPathGuardStrict(requested, { workspaceOnly: true }, workspaceRoot)
        ).rejects.toThrow(/outside the workspace root/);
    });

    it("honors denyPaths with glob patterns (recursive and specific)", async () => {
        const configs = [
            { path: "src/config/secrets.json", pattern: "**/secrets.json" },
            { path: ".env", pattern: ".env" },
            { path: "node_modules/package/index.js", pattern: "node_modules/**" },
        ];

        for (const { path: reqPath, pattern } of configs) {
            const requested = path.join(workspaceRoot, reqPath);
            await expect(
                checkPathGuardStrict(requested, { denyPaths: [pattern] }, workspaceRoot)
            ).rejects.toThrow(/explicitly denied/);
        }
    });

    it("honors allowedPaths with complex glob patterns", async () => {
        const policy = { allowedPaths: ["src/**/*.{ts,tsx}", "public/**/*"] };

        // Valid
        await expect(checkPathGuardStrict(path.join(workspaceRoot, "src/components/Button.tsx"), policy, workspaceRoot)).resolves.toBeDefined();
        await expect(checkPathGuardStrict(path.join(workspaceRoot, "public/assets/logo.png"), policy, workspaceRoot)).resolves.toBeDefined();

        // Invalid
        await expect(checkPathGuardStrict(path.join(workspaceRoot, "src/styles/main.css"), policy, workspaceRoot)).rejects.toThrow(/not in the allowedPaths list/);
        await expect(checkPathGuardStrict(path.join(workspaceRoot, "package.json"), policy, workspaceRoot)).rejects.toThrow(/not in the allowedPaths list/);
    });

    it("denies access if path is in both allowed and deny lists (precedence check)", async () => {
        const policy = {
            allowedPaths: ["src/**"],
            denyPaths: ["src/internal/**"]
        };

        // Allowed
        await expect(checkPathGuardStrict(path.join(workspaceRoot, "src/index.ts"), policy, workspaceRoot)).resolves.toBeDefined();

        // Denied (precedence)
        await expect(checkPathGuardStrict(path.join(workspaceRoot, "src/internal/utils.ts"), policy, workspaceRoot)).rejects.toThrow(/explicitly denied/);
    });

    it("handles paths with special characters and spaces", async () => {
        const requested = path.join(workspaceRoot, "my folder/data (v1).txt");
        const policy = { allowedPaths: ["my folder/**"] };

        await expect(checkPathGuardStrict(requested, policy, workspaceRoot)).resolves.toBeDefined();
    });

    it("resolves paths correctly even if they contain redundant separators or dots", async () => {
        const requested = path.join(workspaceRoot, "src/../src/./index.ts");
        const resolved = path.join(realWorkspaceRoot, "src/index.ts");

        (fs.realpath as any).mockImplementation((p: string) => {
            const normalized = path.resolve(p).replace(/\\/g, "/");
            if (normalized === path.resolve(workspaceRoot).replace(/\\/g, "/")) return Promise.resolve(realWorkspaceRoot);
            // resolveRealPathStrict will resolve src/../src/./index.ts to src/index.ts
            if (normalized === path.resolve(workspaceRoot, "src/index.ts").replace(/\\/g, "/")) return Promise.resolve(resolved);
            return Promise.resolve(normalized);
        });

        const result = await checkPathGuardStrict(requested, { workspaceOnly: true }, workspaceRoot);
        expect(result).toBe(resolved);
    });
});
