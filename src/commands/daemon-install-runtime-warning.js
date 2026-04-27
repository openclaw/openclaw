import { renderSystemNodeWarning, resolveSystemNodeInfo } from "../daemon/runtime-paths.js";
export async function emitNodeRuntimeWarning(params) {
    if (params.runtime !== "node") {
        return;
    }
    const systemNode = await resolveSystemNodeInfo({ env: params.env });
    const warning = renderSystemNodeWarning(systemNode, params.nodeProgram);
    if (warning) {
        params.warn?.(warning, params.title);
    }
}
