import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { resolveSandboxToolPolicyForAgent } from "../agents/sandbox/tool-policy.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import { resolveToolProfilePolicy } from "../agents/tool-policy.js";
import { resolveAgentModelFallbackValues, resolveAgentModelPrimaryValue, } from "../config/model-input.js";
import { hasConfiguredInternalHooks } from "../hooks/configured.js";
import { hasConfiguredWebSearchCredential } from "../plugins/web-search-credential-presence.js";
import { inferParamBFromIdOrName } from "../shared/model-param-b.js";
import { pickSandboxToolPolicy } from "./audit-tool-policy.js";
const SMALL_MODEL_PARAM_B_MAX = 300;
function summarizeGroupPolicy(cfg) {
    const channels = cfg.channels;
    if (!channels || typeof channels !== "object") {
        return { open: 0, allowlist: 0, other: 0 };
    }
    let open = 0;
    let allowlist = 0;
    let other = 0;
    for (const value of Object.values(channels)) {
        if (!value || typeof value !== "object") {
            continue;
        }
        const section = value;
        const policy = section.groupPolicy;
        if (policy === "open") {
            open += 1;
        }
        else if (policy === "allowlist") {
            allowlist += 1;
        }
        else {
            other += 1;
        }
    }
    return { open, allowlist, other };
}
function addModel(models, raw, source) {
    if (typeof raw !== "string") {
        return;
    }
    const id = raw.trim();
    if (!id) {
        return;
    }
    models.push({ id, source });
}
function collectModels(cfg) {
    const out = [];
    addModel(out, resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model), "agents.defaults.model.primary");
    for (const fallback of resolveAgentModelFallbackValues(cfg.agents?.defaults?.model)) {
        addModel(out, fallback, "agents.defaults.model.fallbacks");
    }
    addModel(out, resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel), "agents.defaults.imageModel.primary");
    for (const fallback of resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel)) {
        addModel(out, fallback, "agents.defaults.imageModel.fallbacks");
    }
    const list = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
    for (const agent of list ?? []) {
        if (!agent || typeof agent !== "object") {
            continue;
        }
        const id = typeof agent.id === "string" ? agent.id : "";
        const model = agent.model;
        if (typeof model === "string") {
            addModel(out, model, `agents.list.${id}.model`);
        }
        else if (model && typeof model === "object") {
            addModel(out, model.primary, `agents.list.${id}.model.primary`);
            const fallbacks = model.fallbacks;
            if (Array.isArray(fallbacks)) {
                for (const fallback of fallbacks) {
                    addModel(out, fallback, `agents.list.${id}.model.fallbacks`);
                }
            }
        }
    }
    return out;
}
function extractAgentIdFromSource(source) {
    const match = source.match(/^agents\.list\.([^.]*)\./);
    return match?.[1] ?? null;
}
function resolveToolPolicies(params) {
    const policies = [];
    const profile = params.agentTools?.profile ?? params.cfg.tools?.profile;
    const profilePolicy = resolveToolProfilePolicy(profile);
    if (profilePolicy) {
        policies.push(profilePolicy);
    }
    const globalPolicy = pickSandboxToolPolicy(params.cfg.tools ?? undefined);
    if (globalPolicy) {
        policies.push(globalPolicy);
    }
    const agentPolicy = pickSandboxToolPolicy(params.agentTools);
    if (agentPolicy) {
        policies.push(agentPolicy);
    }
    if (params.sandboxMode === "all") {
        policies.push(resolveSandboxToolPolicyForAgent(params.cfg, params.agentId ?? undefined));
    }
    return policies;
}
function hasWebSearchKey(cfg, env) {
    return hasConfiguredWebSearchCredential({
        config: cfg,
        env,
        origin: "bundled",
        bundledAllowlistCompat: true,
    });
}
function isWebSearchEnabled(cfg, env) {
    const enabled = cfg.tools?.web?.search?.enabled;
    if (enabled === false) {
        return false;
    }
    if (enabled === true) {
        return true;
    }
    return hasWebSearchKey(cfg, env);
}
function isWebFetchEnabled(cfg) {
    const enabled = cfg.tools?.web?.fetch?.enabled;
    if (enabled === false) {
        return false;
    }
    return true;
}
function isBrowserEnabled(cfg) {
    return cfg.browser?.enabled !== false;
}
export function collectAttackSurfaceSummaryFindings(cfg) {
    const group = summarizeGroupPolicy(cfg);
    const elevated = cfg.tools?.elevated?.enabled !== false;
    const webhooksEnabled = cfg.hooks?.enabled === true;
    const internalHooksEnabled = hasConfiguredInternalHooks(cfg);
    const browserEnabled = cfg.browser?.enabled ?? true;
    const detail = `groups: open=${group.open}, allowlist=${group.allowlist}` +
        `\n` +
        `tools.elevated: ${elevated ? "enabled" : "disabled"}` +
        `\n` +
        `hooks.webhooks: ${webhooksEnabled ? "enabled" : "disabled"}` +
        `\n` +
        `hooks.internal: ${internalHooksEnabled ? "enabled" : "disabled"}` +
        `\n` +
        `browser control: ${browserEnabled ? "enabled" : "disabled"}` +
        `\n` +
        "trust model: personal assistant (one trusted operator boundary), not hostile multi-tenant on one shared gateway";
    return [
        {
            checkId: "summary.attack_surface",
            severity: "info",
            title: "Attack surface summary",
            detail,
        },
    ];
}
export function collectSmallModelRiskFindings(params) {
    const findings = [];
    const models = collectModels(params.cfg).filter((entry) => !entry.source.includes("imageModel"));
    if (models.length === 0) {
        return findings;
    }
    const smallModels = models
        .map((entry) => {
        const paramB = inferParamBFromIdOrName(entry.id);
        if (!paramB || paramB > SMALL_MODEL_PARAM_B_MAX) {
            return null;
        }
        return { ...entry, paramB };
    })
        .filter((entry) => Boolean(entry));
    if (smallModels.length === 0) {
        return findings;
    }
    let hasUnsafe = false;
    const modelLines = [];
    const exposureSet = new Set();
    for (const entry of smallModels) {
        const agentId = extractAgentIdFromSource(entry.source);
        const sandboxMode = resolveSandboxConfigForAgent(params.cfg, agentId ?? undefined).mode;
        const agentTools = agentId && params.cfg.agents?.list
            ? params.cfg.agents.list.find((agent) => agent?.id === agentId)?.tools
            : undefined;
        const policies = resolveToolPolicies({
            cfg: params.cfg,
            agentTools,
            sandboxMode,
            agentId,
        });
        const exposed = [];
        if (isWebSearchEnabled(params.cfg, params.env) &&
            isToolAllowedByPolicies("web_search", policies)) {
            exposed.push("web_search");
        }
        if (isWebFetchEnabled(params.cfg) && isToolAllowedByPolicies("web_fetch", policies)) {
            exposed.push("web_fetch");
        }
        if (isBrowserEnabled(params.cfg) && isToolAllowedByPolicies("browser", policies)) {
            exposed.push("browser");
        }
        for (const tool of exposed) {
            exposureSet.add(tool);
        }
        const sandboxLabel = sandboxMode === "all" ? "sandbox=all" : `sandbox=${sandboxMode}`;
        const exposureLabel = exposed.length > 0 ? ` web=[${exposed.join(", ")}]` : " web=[off]";
        const safe = sandboxMode === "all" && exposed.length === 0;
        if (!safe) {
            hasUnsafe = true;
        }
        const statusLabel = safe ? "ok" : "unsafe";
        modelLines.push(`- ${entry.id} (${entry.paramB}B) @ ${entry.source} (${statusLabel}; ${sandboxLabel};${exposureLabel})`);
    }
    const exposureList = Array.from(exposureSet);
    const exposureDetail = exposureList.length > 0
        ? `Uncontrolled input tools allowed: ${exposureList.join(", ")}.`
        : "No web/browser tools detected for these models.";
    findings.push({
        checkId: "models.small_params",
        severity: hasUnsafe ? "critical" : "info",
        title: "Small models require sandboxing and web tools disabled",
        detail: `Small models (<=${SMALL_MODEL_PARAM_B_MAX}B params) detected:\n` +
            modelLines.join("\n") +
            `\n` +
            exposureDetail +
            `\n` +
            "Small models are not recommended for untrusted inputs.",
        remediation: 'If you must use small models, enable sandboxing for all sessions (agents.defaults.sandbox.mode="all") and disable web_search/web_fetch/browser (tools.deny=["group:web","browser"]).',
    });
    return findings;
}
