import { applyOwnerOnlyToolPolicy } from "../agents/tool-policy.js";
import { clearActiveMcpLoopbackRuntimeByOwnerToken, createMcpLoopbackServerConfig, getActiveMcpLoopbackRuntime, setActiveMcpLoopbackRuntime, } from "./mcp-http.loopback-runtime.js";
import { buildMcpToolSchema, } from "./mcp-http.schema.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";
const TOOL_CACHE_TTL_MS = 30_000;
const NATIVE_TOOL_EXCLUDE = new Set(["read", "write", "edit", "apply_patch", "exec", "process"]);
export class McpLoopbackToolCache {
    #entries = new Map();
    resolve(params) {
        const cacheKey = [
            params.sessionKey,
            params.messageProvider ?? "",
            params.accountId ?? "",
            params.senderIsOwner === true ? "owner" : "non-owner",
        ].join("\u0000");
        const now = Date.now();
        const cached = this.#entries.get(cacheKey);
        if (cached && cached.configRef === params.cfg && now - cached.time < TOOL_CACHE_TTL_MS) {
            return cached;
        }
        const next = resolveGatewayScopedTools({
            cfg: params.cfg,
            sessionKey: params.sessionKey,
            messageProvider: params.messageProvider,
            accountId: params.accountId,
            senderIsOwner: params.senderIsOwner,
            surface: "loopback",
            excludeToolNames: NATIVE_TOOL_EXCLUDE,
        });
        const tools = applyOwnerOnlyToolPolicy(next.tools, params.senderIsOwner === true);
        const nextEntry = {
            agentId: next.agentId,
            tools,
            toolSchema: buildMcpToolSchema(tools),
            configRef: params.cfg,
            time: now,
        };
        this.#entries.set(cacheKey, nextEntry);
        for (const [key, entry] of this.#entries) {
            if (now - entry.time >= TOOL_CACHE_TTL_MS) {
                this.#entries.delete(key);
            }
        }
        return nextEntry;
    }
}
export { clearActiveMcpLoopbackRuntimeByOwnerToken, createMcpLoopbackServerConfig, getActiveMcpLoopbackRuntime, setActiveMcpLoopbackRuntime, };
