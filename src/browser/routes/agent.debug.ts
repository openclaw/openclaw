import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BrowserRouteContext } from "../server-context.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { assertSandboxPath } from "../agents/sandbox-paths.js";
import { handleRouteError, readBody, requirePwAi, resolveProfileContext } from "./agent.shared.js";
import { jsonError, toBoolean, toStringOrEmpty } from "./utils.js";

const TRACE_ROOT = "/tmp/openclaw/traces";

export function registerBrowserAgentDebugRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.get("/console", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    const targetId = typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    const level = typeof req.query.level === "string" ? req.query.level : "";

    try {
      const tab = await profileCtx.ensureTabAvailable(targetId || undefined);
      const pw = await requirePwAi(res, "console messages");
      if (!pw) {
        return;
      }
      const messages = await pw.getConsoleMessagesViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        level: level.trim() || undefined,
      });
      res.json({ ok: true, messages, targetId: tab.targetId });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.get("/errors", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    const targetId = typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    const clear = toBoolean(req.query.clear) ?? false;

    try {
      const tab = await profileCtx.ensureTabAvailable(targetId || undefined);
      const pw = await requirePwAi(res, "page errors");
      if (!pw) {
        return;
      }
      const result = await pw.getPageErrorsViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        clear,
      });
      res.json({ ok: true, targetId: tab.targetId, ...result });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.get("/requests", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    const targetId = typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    const filter = typeof req.query.filter === "string" ? req.query.filter : "";
    const clear = toBoolean(req.query.clear) ?? false;

    try {
      const tab = await profileCtx.ensureTabAvailable(targetId || undefined);
      const pw = await requirePwAi(res, "network requests");
      if (!pw) {
        return;
      }
      const result = await pw.getNetworkRequestsViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        filter: filter.trim() || undefined,
        clear,
      });
      res.json({ ok: true, targetId: tab.targetId, ...result });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/trace/start", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const screenshots = toBoolean(body.screenshots) ?? undefined;
    const snapshots = toBoolean(body.snapshots) ?? undefined;
    const sources = toBoolean(body.sources) ?? undefined;
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "trace start");
      if (!pw) {
        return;
      }
      await pw.traceStartViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        screenshots,
        snapshots,
        sources,
      });
      res.json({ ok: true, targetId: tab.targetId });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/trace/stop", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const out = toStringOrEmpty(body.path) || "";
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "trace stop");
      if (!pw) {
        return;
      }
      const id = crypto.randomUUID();
      await fs.mkdir(TRACE_ROOT, { recursive: true });
      const rawPath = out.trim() || path.join(TRACE_ROOT, `browser-trace-${id}.zip`);
      let tracePath = "";
      try {
        const validated = await assertSandboxPath({
          filePath: rawPath,
          cwd: TRACE_ROOT,
          root: TRACE_ROOT,
        });
        tracePath = validated.resolved;
      } catch {
        return jsonError(res, 400, `trace path must stay within ${TRACE_ROOT}`);
      }
      await pw.traceStopViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        path: tracePath,
      });
      res.json({
        ok: true,
        targetId: tab.targetId,
        path: tracePath,
      });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });
}
