import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { getProfileContext, jsonError, toNumber, toStringOrEmpty } from "./utils.js";

function resolveTabsProfileContext(
  req: BrowserRequest,
  res: BrowserResponse,
  ctx: BrowserRouteContext,
) {
  const profileCtx = getProfileContext(req, ctx);
  if ("error" in profileCtx) {
    jsonError(res, profileCtx.status, profileCtx.error);
    return null;
  }
  return profileCtx;
}

function handleTabsRouteError(
  ctx: BrowserRouteContext,
  res: BrowserResponse,
  err: unknown,
  opts?: { mapTabError?: boolean },
) {
  if (opts?.mapTabError) {
    const mapped = ctx.mapTabError(err);
    if (mapped) {
      return jsonError(res, mapped.status, mapped.message);
    }
  }
  return jsonError(res, 500, String(err));
}

async function withTabsProfileRoute(params: {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  mapTabError?: boolean;
  run: (profileCtx: ProfileContext) => Promise<void>;
}) {
  const profileCtx = resolveTabsProfileContext(params.req, params.res, params.ctx);
  if (!profileCtx) {
    return;
  }
  try {
    await params.run(profileCtx);
  } catch (err) {
    handleTabsRouteError(params.ctx, params.res, err, { mapTabError: params.mapTabError });
  }
}

export function registerBrowserTabRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  app.get("/tabs", async (req, res) => {
    await withTabsProfileRoute({
      req,
      res,
      ctx,
      run: async (profileCtx) => {
        const reachable = await profileCtx.isReachable(300);
        if (!reachable) {
          return res.json({ running: false, tabs: [] as unknown[] });
        }
        const tabs = await profileCtx.listTabs();
        res.json({ running: true, tabs });
      },
    });
  });

  app.post("/tabs/open", async (req, res) => {
    const url = toStringOrEmpty((req.body as { url?: unknown })?.url);
    if (!url) {
      return jsonError(res, 400, "url is required");
    }

    await withTabsProfileRoute({
      req,
      res,
      ctx,
      run: async (profileCtx) => {
        await profileCtx.ensureBrowserAvailable();
        const tab = await profileCtx.openTab(url);
        res.json(tab);
      },
    });
  });

  app.post("/tabs/focus", async (req, res) => {
    const targetId = toStringOrEmpty((req.body as { targetId?: unknown })?.targetId);
    if (!targetId) {
      return jsonError(res, 400, "targetId is required");
    }

    await withTabsProfileRoute({
      req,
      res,
      ctx,
      mapTabError: true,
      run: async (profileCtx) => {
        if (!(await profileCtx.isReachable(300))) {
          return jsonError(res, 409, "browser not running");
        }
        await profileCtx.focusTab(targetId);
        res.json({ ok: true });
      },
    });
  });

  app.delete("/tabs/:targetId", async (req, res) => {
    const targetId = toStringOrEmpty(req.params.targetId);
    if (!targetId) {
      return jsonError(res, 400, "targetId is required");
    }

    await withTabsProfileRoute({
      req,
      res,
      ctx,
      mapTabError: true,
      run: async (profileCtx) => {
        if (!(await profileCtx.isReachable(300))) {
          return jsonError(res, 409, "browser not running");
        }
        await profileCtx.closeTab(targetId);
        res.json({ ok: true });
      },
    });
  });

  app.post("/tabs/action", async (req, res) => {
    const action = toStringOrEmpty((req.body as { action?: unknown })?.action);
    const index = toNumber((req.body as { index?: unknown })?.index);

    await withTabsProfileRoute({
      req,
      res,
      ctx,
      mapTabError: true,
      run: async (profileCtx) => {
        if (action === "list") {
          const reachable = await profileCtx.isReachable(300);
          if (!reachable) {
            return res.json({ ok: true, tabs: [] as unknown[] });
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
          const target = typeof index === "number" ? tabs[index] : tabs.at(0);
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
