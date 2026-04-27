import path from "node:path";
import { resolvePreferredNodePath } from "../daemon/runtime-paths.js";
import { emitNodeRuntimeWarning, } from "./daemon-install-runtime-warning.js";
export function resolveGatewayDevMode(argv = process.argv) {
    const entry = argv[1];
    const normalizedEntry = entry?.replaceAll("\\", "/");
    return normalizedEntry?.includes("/src/") && normalizedEntry.endsWith(".ts");
}
export async function resolveDaemonInstallRuntimeInputs(params) {
    const devMode = params.devMode ?? resolveGatewayDevMode();
    const nodePath = params.nodePath ??
        (await resolvePreferredNodePath({
            env: params.env,
            runtime: params.runtime,
        }));
    return { devMode, nodePath };
}
export async function emitDaemonInstallRuntimeWarning(params) {
    await emitNodeRuntimeWarning({
        env: params.env,
        runtime: params.runtime,
        nodeProgram: params.programArguments[0],
        warn: params.warn,
        title: params.title,
    });
}
export function resolveDaemonNodeBinDir(nodePath) {
    const trimmed = nodePath?.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) {
        return undefined;
    }
    return [path.dirname(trimmed)];
}
