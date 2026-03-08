import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolFsPolicy } from "../agents/tool-fs-policy.js";
import { PathGuardError, checkPathGuardStrict } from "./path-guard.js";

describe("checkPathGuardStrict", () => {
    let tmpDir: string;
    let workspaceDir: string;
    let outsideDir: string;
    let insideFile: string;
    let outsideFile: string;
    let secretFile: string;
    let symlinkToOutside: string;

    beforeAll(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pathguard-test-"));
        workspaceDir = path.join(tmpDir, "workspace");
        outsideDir = path.join(tmpDir, "outside");

        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(outsideDir, { recursive: true });

        insideFile = path.join(workspaceDir, "test.txt");
        outsideFile = path.join(outsideDir, "test.txt");
        secretFile = path.join(workspaceDir, "secret.env");

        await fs.writeFile(insideFile, "hello");
        await fs.writeFile(outsideFile, "outside");
        await fs.writeFile(secretFile, "SECRET=123");

        symlinkToOutside = path.join(workspaceDir, "symlink-to-outside");
        try {
            await fs.symlink(outsideDir, symlinkToOutside, "dir");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EPERM') {
                // Windows requires admin privileges for symlinks sometimes, ignore if it fails
            }
        }
    });

    afterAll(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("should allow access when no explicit policy is provided and workspaceOnly is false", async () => {
        const policy: ToolFsPolicy = { workspaceOnly: false };
        await expect(checkPathGuardStrict(insideFile, policy, workspaceDir)).resolves.toBeUndefined();
        await expect(checkPathGuardStrict(outsideFile, policy, workspaceDir)).resolves.toBeUndefined();
    });

    it("should restrict to workspace when workspaceOnly is true and no paths provided", async () => {
        const policy: ToolFsPolicy = { workspaceOnly: true };
        await expect(checkPathGuardStrict(insideFile, policy, workspaceDir)).resolves.toBeUndefined();
        await expect(checkPathGuardStrict(outsideFile, policy, workspaceDir)).rejects.toThrow(PathGuardError);
        await expect(checkPathGuardStrict(outsideFile, policy, workspaceDir)).rejects.toThrow("outside workspace root");
    });

    it("should enforce denyPaths and take precedence over workspace", async () => {
        const policy: ToolFsPolicy = {
            workspaceOnly: true,
            denyPaths: ["secret.env"] // workspace-relative
        };
        await expect(checkPathGuardStrict(insideFile, policy, workspaceDir)).resolves.toBeUndefined();
        await expect(checkPathGuardStrict(secretFile, policy, workspaceDir)).rejects.toThrow(PathGuardError);
        await expect(checkPathGuardStrict(secretFile, policy, workspaceDir)).rejects.toThrow("explicitly denied");
    });

    it("should enforce denyPaths with absolute paths", async () => {
        const policy: ToolFsPolicy = {
            workspaceOnly: false,
            denyPaths: [secretFile]
        };
        await expect(checkPathGuardStrict(secretFile, policy, workspaceDir)).rejects.toThrow(PathGuardError);
    });

    it("should only allow allowedPaths when defined", async () => {
        const policy: ToolFsPolicy = {
            workspaceOnly: false,
            allowedPaths: [insideFile]
        };
        await expect(checkPathGuardStrict(insideFile, policy, workspaceDir)).resolves.toBeUndefined();
        await expect(checkPathGuardStrict(secretFile, policy, workspaceDir)).rejects.toThrow(PathGuardError);
        await expect(checkPathGuardStrict(secretFile, policy, workspaceDir)).rejects.toThrow("not in allowed paths");
    });

    it("should block traversal attacks (../)", async () => {
        const policy: ToolFsPolicy = { workspaceOnly: true };
        const attackPath = path.join(workspaceDir, "..", "outside", "test.txt");
        await expect(checkPathGuardStrict(attackPath, policy, workspaceDir)).rejects.toThrow(PathGuardError);
    });

    it("should block symlink escapes", async () => {
        // If symlink creation was skipped on Windows due to perms, skip this test
        let stat;
        try {
            stat = await fs.lstat(symlinkToOutside);
        } catch {
            return;
        }

        if (stat.isSymbolicLink()) {
            const policy: ToolFsPolicy = { workspaceOnly: true };
            const escapePath = path.join(symlinkToOutside, "test.txt");
            await expect(checkPathGuardStrict(escapePath, policy, workspaceDir)).rejects.toThrow(PathGuardError);
        }
    });

    it("should deny access if allowedPaths exist and path matches neither", async () => {
        const policy: ToolFsPolicy = {
            workspaceOnly: true, // This gets overridden by explicit allowedPaths
            allowedPaths: ["dummy-dir"]
        };
        await expect(checkPathGuardStrict(insideFile, policy, workspaceDir)).rejects.toThrow(PathGuardError);
    });
});
