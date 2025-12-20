import path from "node:path";

import type express from "express";

import { ensureMediaDir, saveMediaBuffer } from "../../media/store.js";
import { captureScreenshot, snapshotAria } from "../cdp.js";
import {
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
  normalizeBrowserScreenshot,
} from "../screenshot.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  jsonError,
  toBoolean,
  toNumber,
  toStringArray,
  toStringOrEmpty,
} from "./utils.js";

type ActKind =
  | "click"
  | "close"
  | "drag"
  | "evaluate"
  | "fill"
  | "hover"
  | "press"
  | "resize"
  | "select"
  | "type"
  | "wait";

type ClickButton = "left" | "right" | "middle";
type ClickModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";

function readBody(req: express.Request): Record<string, unknown> {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return body;
}

function handleRouteError(
  ctx: BrowserRouteContext,
  res: express.Response,
  err: unknown,
) {
  const mapped = ctx.mapTabError(err);
  if (mapped) return jsonError(res, mapped.status, mapped.message);
  jsonError(res, 500, String(err));
}

function parseClickButton(raw: string): ClickButton | undefined {
  if (raw === "left" || raw === "right" || raw === "middle") return raw;
  return undefined;
}

type PwAiModule = typeof import("../pw-ai.js");
let pwAiModule: Promise<PwAiModule | null> | null = null;

async function getPwAiModule(): Promise<PwAiModule | null> {
  if (pwAiModule) return pwAiModule;
  pwAiModule = (async () => {
    try {
      return await import("../pw-ai.js");
    } catch {
      return null;
    }
  })();
  return pwAiModule;
}

async function requirePwAi(
  res: express.Response,
  feature: string,
): Promise<PwAiModule | null> {
  const mod = await getPwAiModule();
  if (mod) return mod;
  jsonError(
    res,
    501,
    `Playwright is not available in this gateway build; '${feature}' is unsupported.`,
  );
  return null;
}

export function registerBrowserAgentRoutes(
  app: express.Express,
  ctx: BrowserRouteContext,
) {
  app.post("/navigate", async (req, res) => {
    const body = readBody(req);
    const url = toStringOrEmpty(body.url);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    if (!url) return jsonError(res, 400, "url is required");
    try {
      const tab = await ctx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "navigate");
      if (!pw) return;
      const result = await pw.navigateViaPlaywright({
        cdpPort: ctx.state().cdpPort,
        targetId: tab.targetId,
        url,
      });
      res.json({ ok: true, targetId: tab.targetId, ...result });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/act", async (req, res) => {
    const body = readBody(req);
    const kind = toStringOrEmpty(body.kind) as ActKind;
    const targetId = toStringOrEmpty(body.targetId) || undefined;

    if (
      kind !== "click" &&
      kind !== "close" &&
      kind !== "drag" &&
      kind !== "evaluate" &&
      kind !== "fill" &&
      kind !== "hover" &&
      kind !== "press" &&
      kind !== "resize" &&
      kind !== "select" &&
      kind !== "type" &&
      kind !== "wait"
    ) {
      return jsonError(res, 400, "kind is required");
    }

    try {
      const tab = await ctx.ensureTabAvailable(targetId);
      const cdpPort = ctx.state().cdpPort;
      const pw = await requirePwAi(res, `act:${kind}`);
      if (!pw) return;

      switch (kind) {
        case "click": {
          const ref = toStringOrEmpty(body.ref);
          if (!ref) return jsonError(res, 400, "ref is required");
          const doubleClick = toBoolean(body.doubleClick) ?? false;
          const buttonRaw = toStringOrEmpty(body.button) || "";
          const button = buttonRaw ? parseClickButton(buttonRaw) : undefined;
          if (buttonRaw && !button)
            return jsonError(res, 400, "button must be left|right|middle");

          const modifiersRaw = toStringArray(body.modifiers) ?? [];
          const allowedModifiers = new Set<ClickModifier>([
            "Alt",
            "Control",
            "ControlOrMeta",
            "Meta",
            "Shift",
          ]);
          const invalidModifiers = modifiersRaw.filter(
            (m) => !allowedModifiers.has(m as ClickModifier),
          );
          if (invalidModifiers.length)
            return jsonError(
              res,
              400,
              "modifiers must be Alt|Control|ControlOrMeta|Meta|Shift",
            );
          const modifiers = modifiersRaw.length
            ? (modifiersRaw as ClickModifier[])
            : undefined;
          await pw.clickViaPlaywright({
            cdpPort,
            targetId: tab.targetId,
            ref,
            doubleClick,
            button,
            modifiers,
          });
          return res.json({ ok: true, targetId: tab.targetId, url: tab.url });
        }
        case "type": {
          const ref = toStringOrEmpty(body.ref);
          if (!ref) return jsonError(res, 400, "ref is required");
          if (typeof body.text !== "string")
            return jsonError(res, 400, "text is required");
          const text = body.text;
          const submit = toBoolean(body.submit) ?? false;
          const slowly = toBoolean(body.slowly) ?? false;
          await pw.typeViaPlaywright({
            cdpPort,
            targetId: tab.targetId,
            ref,
            text,
            submit,
            slowly,
          });
          return res.json({ ok: true, targetId: tab.targetId });
        }
        case "press": {
          const key = toStringOrEmpty(body.key);
          if (!key) return jsonError(res, 400, "key is required");
          await pw.pressKeyViaPlaywright({ cdpPort, targetId: tab.targetId, key });
          return res.json({ ok: true, targetId: tab.targetId });
        }
        case "hover": {
          const ref = toStringOrEmpty(body.ref);
          if (!ref) return jsonError(res, 400, "ref is required");
          await pw.hoverViaPlaywright({ cdpPort, targetId: tab.targetId, ref });
          return res.json({ ok: true, targetId: tab.targetId });
        }
        case "drag": {
          const startRef = toStringOrEmpty(body.startRef);
          const endRef = toStringOrEmpty(body.endRef);
          if (!startRef || !endRef)
            return jsonError(res, 400, "startRef and endRef are required");
          await pw.dragViaPlaywright({
            cdpPort,
            targetId: tab.targetId,
            startRef,
            endRef,
          });
          return res.json({ ok: true, targetId: tab.targetId });
        }
        case "select": {
          const ref = toStringOrEmpty(body.ref);
          const values = toStringArray(body.values);
          if (!ref || !values?.length)
            return jsonError(res, 400, "ref and values are required");
          await pw.selectOptionViaPlaywright({
            cdpPort,
            targetId: tab.targetId,
            ref,
            values,
          });
          return res.json({ ok: true, targetId: tab.targetId });
        }
        case "fill": {
          const fields = Array.isArray(body.fields)
            ? (body.fields as Array<Record<string, unknown>>)
            : null;
          if (!fields?.length)
            return jsonError(res, 400, "fields are required");
          await pw.fillFormViaPlaywright({
            cdpPort,
            targetId: tab.targetId,
            fields,
          });
          return res.json({ ok: true, targetId: tab.targetId });
        }
        case "resize": {
          const width = toNumber(body.width);
          const height = toNumber(body.height);
          if (!width || !height)
            return jsonError(res, 400, "width and height are required");
          await pw.resizeViewportViaPlaywright({
            cdpPort,
            targetId: tab.targetId,
            width,
            height,
          });
          return res.json({ ok: true, targetId: tab.targetId, url: tab.url });
        }
        case "wait": {
          const timeMs = toNumber(body.timeMs);
          const text = toStringOrEmpty(body.text) || undefined;
          const textGone = toStringOrEmpty(body.textGone) || undefined;
          await pw.waitForViaPlaywright({
            cdpPort,
            targetId: tab.targetId,
            timeMs,
            text,
            textGone,
          });
          return res.json({ ok: true, targetId: tab.targetId });
        }
        case "evaluate": {
          const fn = toStringOrEmpty(body.fn);
          if (!fn) return jsonError(res, 400, "fn is required");
          const ref = toStringOrEmpty(body.ref) || undefined;
          const result = await pw.evaluateViaPlaywright({
            cdpPort,
            targetId: tab.targetId,
            fn,
            ref,
          });
          return res.json({
            ok: true,
            targetId: tab.targetId,
            url: tab.url,
            result,
          });
        }
        case "close": {
          await pw.closePageViaPlaywright({ cdpPort, targetId: tab.targetId });
          return res.json({ ok: true, targetId: tab.targetId });
        }
        default: {
          return jsonError(res, 400, "unsupported kind");
        }
      }
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/hooks/file-chooser", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const paths = toStringArray(body.paths) ?? [];
    const timeoutMs = toNumber(body.timeoutMs);
    if (!paths.length) return jsonError(res, 400, "paths are required");
    try {
      const tab = await ctx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "file chooser hook");
      if (!pw) return;
      await pw.armFileUploadViaPlaywright({
        cdpPort: ctx.state().cdpPort,
        targetId: tab.targetId,
        paths,
        timeoutMs: timeoutMs ?? undefined,
      });
      res.json({ ok: true });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/hooks/dialog", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const accept = toBoolean(body.accept);
    const promptText = toStringOrEmpty(body.promptText) || undefined;
    const timeoutMs = toNumber(body.timeoutMs);
    if (accept === undefined) return jsonError(res, 400, "accept is required");
    try {
      const tab = await ctx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "dialog hook");
      if (!pw) return;
      await pw.armDialogViaPlaywright({
        cdpPort: ctx.state().cdpPort,
        targetId: tab.targetId,
        accept,
        promptText,
        timeoutMs: timeoutMs ?? undefined,
      });
      res.json({ ok: true });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.get("/console", async (req, res) => {
    const targetId =
      typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    const level = typeof req.query.level === "string" ? req.query.level : "";

    try {
      const tab = await ctx.ensureTabAvailable(targetId || undefined);
      const pw = await requirePwAi(res, "console messages");
      if (!pw) return;
      const messages = await pw.getConsoleMessagesViaPlaywright({
        cdpPort: ctx.state().cdpPort,
        targetId: tab.targetId,
        level: level.trim() || undefined,
      });
      res.json({ ok: true, messages, targetId: tab.targetId });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/pdf", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    try {
      const tab = await ctx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "pdf");
      if (!pw) return;
      const pdf = await pw.pdfViaPlaywright({
        cdpPort: ctx.state().cdpPort,
        targetId: tab.targetId,
      });
      await ensureMediaDir();
      const saved = await saveMediaBuffer(
        pdf.buffer,
        "application/pdf",
        "browser",
        pdf.buffer.byteLength,
      );
      res.json({
        ok: true,
        path: path.resolve(saved.path),
        targetId: tab.targetId,
        url: tab.url,
      });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/screenshot", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const fullPage = toBoolean(body.fullPage) ?? false;
    const ref = toStringOrEmpty(body.ref) || undefined;
    const element = toStringOrEmpty(body.element) || undefined;
    const type = body.type === "jpeg" ? "jpeg" : "png";

    if (fullPage && (ref || element)) {
      return jsonError(
        res,
        400,
        "fullPage is not supported for element screenshots",
      );
    }

    try {
      const tab = await ctx.ensureTabAvailable(targetId);
      let buffer: Buffer;
      if (ref || element) {
        const pw = await requirePwAi(res, "element/ref screenshot");
        if (!pw) return;
        const snap = await pw.takeScreenshotViaPlaywright({
          cdpPort: ctx.state().cdpPort,
          targetId: tab.targetId,
          ref,
          element,
          fullPage,
          type,
        });
        buffer = snap.buffer;
      } else {
        buffer = await captureScreenshot({
          wsUrl: tab.wsUrl ?? "",
          fullPage,
          format: type,
          quality: type === "jpeg" ? 85 : undefined,
        });
      }

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
      res.json({
        ok: true,
        path: path.resolve(saved.path),
        targetId: tab.targetId,
        url: tab.url,
      });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.get("/snapshot", async (req, res) => {
    const targetId =
      typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    const format =
      req.query.format === "aria"
        ? "aria"
        : req.query.format === "ai"
          ? "ai"
          : ((await getPwAiModule()) ? "ai" : "aria");
    const limit =
      typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

    try {
      const tab = await ctx.ensureTabAvailable(targetId || undefined);
      if (format === "ai") {
        const pw = await requirePwAi(res, "ai snapshot");
        if (!pw) return;
        const snap = await pw.snapshotAiViaPlaywright({
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
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });
}
