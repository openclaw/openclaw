import { getPwAiModule as getPwAiModuleBase } from "../pw-ai-module.js";
import { getProfileContext, jsonError } from "./utils.js";
export const SELECTOR_UNSUPPORTED_MESSAGE = [
    "Error: 'selector' is not supported. Use 'ref' from snapshot instead.",
    "",
    "Example workflow:",
    "1. snapshot action to get page state with refs",
    '2. act with ref: "e123" to interact with element',
    "",
    "This is more reliable for modern SPAs.",
].join("\n");
export function readBody(req) {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return {};
    }
    return body;
}
export function resolveTargetIdFromBody(body) {
    const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
    return targetId || undefined;
}
export function resolveTargetIdFromQuery(query) {
    const targetId = typeof query.targetId === "string" ? query.targetId.trim() : "";
    return targetId || undefined;
}
export function handleRouteError(ctx, res, err) {
    const mapped = ctx.mapTabError(err);
    if (mapped) {
        return jsonError(res, mapped.status, mapped.message);
    }
    jsonError(res, 500, String(err));
}
export function resolveProfileContext(req, res, ctx) {
    const profileCtx = getProfileContext(req, ctx);
    if ("error" in profileCtx) {
        jsonError(res, profileCtx.status, profileCtx.error);
        return null;
    }
    return profileCtx;
}
export async function getPwAiModule() {
    return await getPwAiModuleBase({ mode: "soft" });
}
export async function requirePwAi(res, feature) {
    const mod = await getPwAiModule();
    if (mod) {
        return mod;
    }
    jsonError(res, 501, [
        `Playwright is not available in this gateway build; '${feature}' is unsupported.`,
        "Install the full Playwright package (not playwright-core) and restart the gateway, or reinstall with browser support.",
        "Docs: /tools/browser#playwright-requirement",
    ].join("\n"));
    return null;
}
export async function withRouteTabContext(params) {
    const profileCtx = resolveProfileContext(params.req, params.res, params.ctx);
    if (!profileCtx) {
        return undefined;
    }
    try {
        const tab = await profileCtx.ensureTabAvailable(params.targetId);
        return await params.run({
            profileCtx,
            tab,
            cdpUrl: profileCtx.profile.cdpUrl,
        });
    }
    catch (err) {
        handleRouteError(params.ctx, params.res, err);
        return undefined;
    }
}
export async function withPlaywrightRouteContext(params) {
    return await withRouteTabContext({
        req: params.req,
        res: params.res,
        ctx: params.ctx,
        targetId: params.targetId,
        run: async ({ profileCtx, tab, cdpUrl }) => {
            const pw = await requirePwAi(params.res, params.feature);
            if (!pw) {
                return undefined;
            }
            return await params.run({ profileCtx, tab, cdpUrl, pw });
        },
    });
}
