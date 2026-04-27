import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectPackageManager as detectPackageManagerImpl } from "./detect-package-manager.js";
import { applyPathPrepend } from "./path-prepend.js";
export async function detectBuildManager(root) {
    return (await detectPackageManagerImpl(root)) ?? "npm";
}
function managerPreferenceOrder(preferred) {
    if (preferred === "pnpm") {
        return ["pnpm", "npm", "bun"];
    }
    if (preferred === "bun") {
        return ["bun", "npm", "pnpm"];
    }
    return ["npm", "pnpm", "bun"];
}
function managerVersionArgs(manager) {
    if (manager === "pnpm") {
        return ["pnpm", "--version"];
    }
    if (manager === "bun") {
        return ["bun", "--version"];
    }
    return ["npm", "--version"];
}
async function isManagerAvailable(runCommand, manager, timeoutMs, env) {
    try {
        const res = await runCommand(managerVersionArgs(manager), { timeoutMs, env });
        return res.code === 0;
    }
    catch {
        return false;
    }
}
async function isCommandAvailable(runCommand, argv, timeoutMs, env) {
    try {
        const res = await runCommand(argv, { timeoutMs, env });
        return res.code === 0;
    }
    catch {
        return false;
    }
}
function cloneCommandEnv(env) {
    return Object.fromEntries(Object.entries(env ?? process.env)
        .filter(([, value]) => value != null)
        .map(([key, value]) => [key, String(value)]));
}
async function enablePnpmViaCorepack(runCommand, timeoutMs, env) {
    if (!(await isCommandAvailable(runCommand, ["corepack", "--version"], timeoutMs, env))) {
        return "missing";
    }
    try {
        const res = await runCommand(["corepack", "enable"], { timeoutMs, env });
        if (res.code !== 0) {
            return "failed";
        }
    }
    catch {
        return "failed";
    }
    return (await isManagerAvailable(runCommand, "pnpm", timeoutMs, env)) ? "enabled" : "failed";
}
async function bootstrapPnpmViaNpm(params) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-pnpm-"));
    const cleanup = async () => {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => { });
    };
    try {
        const installResult = await params.runCommand(["npm", "install", "--prefix", tempRoot, "pnpm@10"], {
            timeoutMs: params.timeoutMs,
            env: params.baseEnv,
        });
        if (installResult.code !== 0) {
            await cleanup();
            return null;
        }
        const env = cloneCommandEnv(params.baseEnv);
        applyPathPrepend(env, [path.join(tempRoot, "node_modules", ".bin")]);
        if (!(await isManagerAvailable(params.runCommand, "pnpm", params.timeoutMs, env))) {
            await cleanup();
            return null;
        }
        return { env, cleanup };
    }
    catch {
        await cleanup();
        return null;
    }
}
export async function resolveUpdateBuildManager(runCommand, root, timeoutMs, baseEnv, requirement = "allow-fallback") {
    const preferred = await detectBuildManager(root);
    if (preferred === "pnpm") {
        if (await isManagerAvailable(runCommand, "pnpm", timeoutMs, baseEnv)) {
            return { kind: "resolved", manager: "pnpm", preferred, fallback: false };
        }
        const corepackStatus = await enablePnpmViaCorepack(runCommand, timeoutMs, baseEnv);
        if (corepackStatus === "enabled") {
            return { kind: "resolved", manager: "pnpm", preferred, fallback: false };
        }
        const npmAvailable = await isManagerAvailable(runCommand, "npm", timeoutMs, baseEnv);
        if (npmAvailable) {
            const pnpmBootstrap = await bootstrapPnpmViaNpm({
                runCommand,
                timeoutMs,
                baseEnv,
            });
            if (pnpmBootstrap) {
                return {
                    kind: "resolved",
                    manager: "pnpm",
                    preferred,
                    fallback: false,
                    env: pnpmBootstrap.env,
                    cleanup: pnpmBootstrap.cleanup,
                };
            }
            if (requirement === "require-preferred") {
                return { kind: "missing-required", preferred, reason: "pnpm-npm-bootstrap-failed" };
            }
        }
        if (requirement === "require-preferred") {
            if (corepackStatus === "missing") {
                return { kind: "missing-required", preferred, reason: "pnpm-corepack-missing" };
            }
            if (corepackStatus === "failed") {
                return { kind: "missing-required", preferred, reason: "pnpm-corepack-enable-failed" };
            }
            return { kind: "missing-required", preferred, reason: "preferred-manager-unavailable" };
        }
    }
    for (const manager of managerPreferenceOrder(preferred)) {
        if (await isManagerAvailable(runCommand, manager, timeoutMs, baseEnv)) {
            return { kind: "resolved", manager, preferred, fallback: manager !== preferred };
        }
    }
    if (requirement === "require-preferred") {
        return { kind: "missing-required", preferred, reason: "preferred-manager-unavailable" };
    }
    return { kind: "resolved", manager: "npm", preferred, fallback: preferred !== "npm" };
}
export function managerScriptArgs(manager, script, args = []) {
    if (manager === "pnpm") {
        return ["pnpm", script, ...args];
    }
    if (manager === "bun") {
        return ["bun", "run", script, ...args];
    }
    if (args.length > 0) {
        return ["npm", "run", script, "--", ...args];
    }
    return ["npm", "run", script];
}
export function managerInstallArgs(manager, opts) {
    if (manager === "pnpm") {
        return ["pnpm", "install"];
    }
    if (manager === "bun") {
        return ["bun", "install"];
    }
    if (opts?.compatFallback) {
        return ["npm", "install", "--no-package-lock", "--legacy-peer-deps"];
    }
    return ["npm", "install"];
}
export function managerInstallIgnoreScriptsArgs(manager) {
    if (manager === "pnpm") {
        return ["pnpm", "install", "--ignore-scripts"];
    }
    if (manager === "bun") {
        return ["bun", "install", "--ignore-scripts"];
    }
    return ["npm", "install", "--ignore-scripts"];
}
