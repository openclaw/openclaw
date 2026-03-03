import { getProfileContext, jsonError, toNumber, toStringOrEmpty } from "./utils.js";
function resolveTabsProfileContext(req, res, ctx) {
    const profileCtx = getProfileContext(req, ctx);
    if ("error" in profileCtx) {
        jsonError(res, profileCtx.status, profileCtx.error);
        return null;
    }
    return profileCtx;
}
function handleTabsRouteError(ctx, res, err, opts) {
    if (opts?.mapTabError) {
        const mapped = ctx.mapTabError(err);
        if (mapped) {
            return jsonError(res, mapped.status, mapped.message);
        }
    }
    return jsonError(res, 500, String(err));
}
async function withTabsProfileRoute(params) {
    const profileCtx = resolveTabsProfileContext(params.req, params.res, params.ctx);
    if (!profileCtx) {
        return;
    }
    try {
        await params.run(profileCtx);
    }
    catch (err) {
        handleTabsRouteError(params.ctx, params.res, err, { mapTabError: params.mapTabError });
    }
}
async function ensureBrowserRunning(profileCtx, res) {
    if (!(await profileCtx.isReachable(300))) {
        jsonError(res, 409, "browser not running");
        return false;
    }
    return true;
}
function resolveIndexedTab(tabs, index) {
    return typeof index === "number" ? tabs[index] : tabs.at(0);
}
function parseRequiredTargetId(res, rawTargetId) {
    const targetId = toStringOrEmpty(rawTargetId);
    if (!targetId) {
        jsonError(res, 400, "targetId is required");
        return null;
    }
    return targetId;
}
async function runTabTargetMutation(params) {
    await withTabsProfileRoute({
        req: params.req,
        res: params.res,
        ctx: params.ctx,
        mapTabError: true,
        run: async (profileCtx) => {
            if (!(await ensureBrowserRunning(profileCtx, params.res))) {
                return;
            }
            await params.mutate(profileCtx, params.targetId);
            params.res.json({ ok: true });
        },
    });
}
export function registerBrowserTabRoutes(app, ctx) {
    app.get("/tabs", async (req, res) => {
        await withTabsProfileRoute({
            req,
            res,
            ctx,
            run: async (profileCtx) => {
                const reachable = await profileCtx.isReachable(300);
                if (!reachable) {
                    return res.json({ running: false, tabs: [] });
                }
                const tabs = await profileCtx.listTabs();
                res.json({ running: true, tabs });
            },
        });
    });
    app.post("/tabs/open", async (req, res) => {
        const url = toStringOrEmpty(req.body?.url);
        if (!url) {
            return jsonError(res, 400, "url is required");
        }
        await withTabsProfileRoute({
            req,
            res,
            ctx,
            mapTabError: true,
            run: async (profileCtx) => {
                await profileCtx.ensureBrowserAvailable();
                const tab = await profileCtx.openTab(url);
                res.json(tab);
            },
        });
    });
    app.post("/tabs/focus", async (req, res) => {
        const targetId = parseRequiredTargetId(res, req.body?.targetId);
        if (!targetId) {
            return;
        }
        await runTabTargetMutation({
            req,
            res,
            ctx,
            targetId,
            mutate: async (profileCtx, id) => {
                await profileCtx.focusTab(id);
            },
        });
    });
    app.delete("/tabs/:targetId", async (req, res) => {
        const targetId = parseRequiredTargetId(res, req.params.targetId);
        if (!targetId) {
            return;
        }
        await runTabTargetMutation({
            req,
            res,
            ctx,
            targetId,
            mutate: async (profileCtx, id) => {
                await profileCtx.closeTab(id);
            },
        });
    });
    app.post("/tabs/action", async (req, res) => {
        const action = toStringOrEmpty(req.body?.action);
        const index = toNumber(req.body?.index);
        await withTabsProfileRoute({
            req,
            res,
            ctx,
            mapTabError: true,
            run: async (profileCtx) => {
                if (action === "list") {
                    const reachable = await profileCtx.isReachable(300);
                    if (!reachable) {
                        return res.json({ ok: true, tabs: [] });
                    }
                    const tabs = await profileCtx.listTabs();
                    return res.json({ ok: true, tabs });
                }
                if (action === "new") {
                    await profileCtx.ensureBrowserAvailable();
                    const tab = await profileCtx.openTab("about:blank");
                    return res.json({ ok: true, tab });
                }
                if (action === "close") {
                    const tabs = await profileCtx.listTabs();
                    const target = resolveIndexedTab(tabs, index);
                    if (!target) {
                        return jsonError(res, 404, "tab not found");
                    }
                    await profileCtx.closeTab(target.targetId);
                    return res.json({ ok: true, targetId: target.targetId });
                }
                if (action === "select") {
                    if (typeof index !== "number") {
                        return jsonError(res, 400, "index is required");
                    }
                    const tabs = await profileCtx.listTabs();
                    const target = tabs[index];
                    if (!target) {
                        return jsonError(res, 404, "tab not found");
                    }
                    await profileCtx.focusTab(target.targetId);
                    return res.json({ ok: true, targetId: target.targetId });
                }
                return jsonError(res, 400, "unknown tab action");
            },
        });
    });
}
