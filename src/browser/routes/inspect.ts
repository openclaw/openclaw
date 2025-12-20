import path from "node:path";

import type express from "express";
import { ensureMediaDir, saveMediaBuffer } from "../../media/store.js";
import {
  captureScreenshot,
  captureScreenshotPng,
  getDomText,
  querySelector,
  snapshotAria,
  snapshotDom,
} from "../cdp.js";
import {
  snapshotAiViaPlaywright,
  takeScreenshotViaPlaywright,
} from "../pw-ai.js";
import {
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
  normalizeBrowserScreenshot,
} from "../screenshot.js";
import type { BrowserRouteContext } from "../server-context.js";
import { jsonError, toBoolean, toStringOrEmpty } from "./utils.js";

export function registerBrowserInspectRoutes(
  app: express.Express,
  ctx: BrowserRouteContext,
) {
  app.get("/screenshot", async (req, res) => {
    const targetId =
      typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    const fullPage =
      req.query.fullPage === "true" || req.query.fullPage === "1";

    try {
      const tab = await ctx.ensureTabAvailable(targetId || undefined);

      let shot: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let contentTypeHint: "image/jpeg" | "image/png" = "image/jpeg";
      try {
        shot = await captureScreenshot({
          wsUrl: tab.wsUrl ?? "",
          fullPage,
          format: "jpeg",
          quality: 85,
        });
      } catch {
        contentTypeHint = "image/png";
        shot = await captureScreenshotPng({
          wsUrl: tab.wsUrl ?? "",
          fullPage,
        });
      }

      const normalized = await normalizeBrowserScreenshot(shot, {
        maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
        maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
      });
      await ensureMediaDir();
      const saved = await saveMediaBuffer(
        normalized.buffer,
        normalized.contentType ?? contentTypeHint,
        "browser",
        DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
      );
      const filePath = path.resolve(saved.path);
      res.json({
        ok: true,
        path: filePath,
        targetId: tab.targetId,
        url: tab.url,
      });
    } catch (err) {
      const mapped = ctx.mapTabError(err);
      if (mapped) return jsonError(res, mapped.status, mapped.message);
      jsonError(res, 500, String(err));
    }
  });

  app.post("/screenshot", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const targetId = toStringOrEmpty(body?.targetId);
    const fullPage = toBoolean(body?.fullPage) ?? false;
    const ref = toStringOrEmpty(body?.ref);
    const element = toStringOrEmpty(body?.element);
    const type = body?.type === "jpeg" ? "jpeg" : "png";
    const filename = toStringOrEmpty(body?.filename);

    try {
      const tab = await ctx.ensureTabAvailable(targetId || undefined);
      const snap = await takeScreenshotViaPlaywright({
        cdpPort: ctx.state().cdpPort,
        targetId: tab.targetId,
        ref,
        element,
        fullPage,
        type,
      });
      const buffer = snap.buffer;
      const normalized = await normalizeBrowserScreenshot(buffer, {
        maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
        maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
      });
      await ensureMediaDir();
      const saved = await saveMediaBuffer(
        normalized.buffer,
        normalized.contentType ?? `image/${type}`,
        "browser",
        DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
      );
      const filePath = path.resolve(saved.path);
      res.json({
        ok: true,
        path: filePath,
        targetId: tab.targetId,
        url: tab.url,
        filename: filename || undefined,
      });
    } catch (err) {
      const mapped = ctx.mapTabError(err);
      if (mapped) return jsonError(res, mapped.status, mapped.message);
      jsonError(res, 500, String(err));
    }
  });

  app.get("/query", async (req, res) => {
    const selector =
      typeof req.query.selector === "string" ? req.query.selector.trim() : "";
    const targetId =
      typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    const limit =
      typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

    if (!selector) return jsonError(res, 400, "selector is required");

    try {
      const tab = await ctx.ensureTabAvailable(targetId || undefined);
      const result = await querySelector({
        wsUrl: tab.wsUrl ?? "",
        selector,
        limit,
      });
      res.json({ ok: true, targetId: tab.targetId, url: tab.url, ...result });
    } catch (err) {
      const mapped = ctx.mapTabError(err);
      if (mapped) return jsonError(res, mapped.status, mapped.message);
      jsonError(res, 500, String(err));
    }
  });

  app.get("/dom", async (req, res) => {
    const targetId =
      typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    const format = req.query.format === "text" ? "text" : "html";
    const selector =
      typeof req.query.selector === "string" ? req.query.selector.trim() : "";
    const maxChars =
      typeof req.query.maxChars === "string"
        ? Number(req.query.maxChars)
        : undefined;

    try {
      const tab = await ctx.ensureTabAvailable(targetId || undefined);
      const result = await getDomText({
        wsUrl: tab.wsUrl ?? "",
        format,
        maxChars,
        selector: selector || undefined,
      });
      res.json({
        ok: true,
        targetId: tab.targetId,
        url: tab.url,
        format,
        ...result,
      });
    } catch (err) {
      const mapped = ctx.mapTabError(err);
      if (mapped) return jsonError(res, mapped.status, mapped.message);
      jsonError(res, 500, String(err));
    }
  });

  app.get("/snapshot", async (req, res) => {
    const targetId =
      typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    const format =
      req.query.format === "domSnapshot"
        ? "domSnapshot"
        : req.query.format === "ai"
          ? "ai"
          : "aria";
    const limit =
      typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

    try {
      const tab = await ctx.ensureTabAvailable(targetId || undefined);

      if (format === "ai") {
        const snap = await snapshotAiViaPlaywright({
          cdpPort: ctx.state().cdpPort,
          targetId: tab.targetId,
        });
        return res.json({
          ok: true,
          format,
          targetId: tab.targetId,
          url: tab.url,
          ...snap,
        });
      }

      if (format === "aria") {
        const snap = await snapshotAria({
          wsUrl: tab.wsUrl ?? "",
          limit,
        });
        return res.json({
          ok: true,
          format,
          targetId: tab.targetId,
          url: tab.url,
          ...snap,
        });
      }

      const snap = await snapshotDom({
        wsUrl: tab.wsUrl ?? "",
        limit,
      });
      return res.json({
        ok: true,
        format,
        targetId: tab.targetId,
        url: tab.url,
        ...snap,
      });
    } catch (err) {
      const mapped = ctx.mapTabError(err);
      if (mapped) return jsonError(res, mapped.status, mapped.message);
      jsonError(res, 500, String(err));
    }
  });
}
