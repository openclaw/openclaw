import { resolveNodeIdFromCandidates } from "./node-match.js";
import { normalizeOptionalString } from "./string-coerce.js";
export function resolveNodeIdFromNodeList(nodes, query, options = {}) {
    const q = normalizeOptionalString(query) ?? "";
    if (!q) {
        if (options.allowDefault === true && options.pickDefaultNode) {
            const picked = options.pickDefaultNode(nodes);
            if (picked) {
                return picked.nodeId;
            }
        }
        throw new Error("node required");
    }
    return resolveNodeIdFromCandidates(nodes, q);
}
export function resolveNodeFromNodeList(nodes, query, options = {}) {
    const nodeId = resolveNodeIdFromNodeList(nodes, query, options);
    return nodes.find((node) => node.nodeId === nodeId) ?? { nodeId };
}
