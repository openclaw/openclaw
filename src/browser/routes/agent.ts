import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type express from "express";

import { ensureMediaDir, saveMediaBuffer } from "../../media/store.js";
import { captureScreenshot, snapshotAria } from "../cdp.js";
import type { BrowserFormField } from "../client-actions-core.js";
import {
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
  normalizeBrowserScreenshot,
} from "../screenshot.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import {
  getProfileContext,
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

const SELECTOR_UNSUPPORTED_MESSAGE = [
  "Error: 'selector' is not supported. Use 'ref' from snapshot instead.",
  "",
  "Example workflow:",
  "1. snapshot action to get page state with refs",
  '2. act with ref: "e123" to interact with element',
  "",
  "This is more reliable for modern SPAs.",
].join("\n");

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

function resolveProfileContext(
  req: express.Request,
  res: express.Response,
  ctx: BrowserRouteContext,
): ProfileContext | null {
  const profileCtx = getProfileContext(req, ctx);
  if ("error" in profileCtx) {
    jsonError(res, profileCtx.status, profileCtx.error);
    return null;
  }
  return profileCtx;
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
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const url = toStringOrEmpty(body.url);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    if (!url) return jsonError(res, 400, "url is required");
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "navigate");
      if (!pw) return;
      const result = await pw.navigateViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        url,
      });
      res.json({ ok: true, targetId: tab.targetId, ...result });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/act", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const kind = toStringOrEmpty(body.kind) as ActKind;
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    if (Object.hasOwn(body, "selector") && kind !== "wait") {
      return jsonError(res, 400, SELECTOR_UNSUPPORTED_MESSAGE);
    }

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
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const cdpUrl = profileCtx.profile.cdpUrl;
      const pw = await requirePwAi(res, `act:${kind}`);
      if (!pw) return;

      switch (kind) {
        case "click": {
          const ref = toStringOrEmpty(body.ref);
          if (!ref) return jsonError(res, 400, "ref is required");
          const doubleClick = toBoolean(body.doubleClick) ?? false;
          const timeoutMs = toNumber(body.timeoutMs);
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
          const clickRequest: Parameters<typeof pw.clickViaPlaywright>[0] = {
            cdpUrl,
            targetId: tab.targetId,
            ref,
            doubleClick,
          };
          if (button) clickRequest.button = button;
          if (modifiers) clickRequest.modifiers = modifiers;
          if (timeoutMs) clickRequest.timeoutMs = timeoutMs;
          await pw.clickViaPlaywright(clickRequest);
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
          const timeoutMs = toNumber(body.timeoutMs);
          const typeRequest: Parameters<typeof pw.typeViaPlaywright>[0] = {
            cdpUrl,
            targetId: tab.targetId,
            ref,
            text,
            submit,
            slowly,
          };
          if (timeoutMs) typeRequest.timeoutMs = timeoutMs;
          await pw.typeViaPlaywright(typeRequest);
          return res.json({ ok: true, targetId: tab.targetId });
        }
        case "press": {
          const key = toStringOrEmpty(body.key);
          if (!key) return jsonError(res, 400, "key is required");
          const delayMs = toNumber(body.delayMs);
          await pw.pressKeyViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            key,
            delayMs: delayMs ?? undefined,
          });
          return res.json({ ok: true, targetId: tab.targetId });
        }
        case "hover": {
          const ref = toStringOrEmpty(body.ref);
          if (!ref) return jsonError(res, 400, "ref is required");
          const timeoutMs = toNumber(body.timeoutMs);
          await pw.hoverViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            ref,
            timeoutMs: timeoutMs ?? undefined,
          });
          return res.json({ ok: true, targetId: tab.targetId });
        }
        case "drag": {
          const startRef = toStringOrEmpty(body.startRef);
          const endRef = toStringOrEmpty(body.endRef);
          if (!startRef || !endRef)
            return jsonError(res, 400, "startRef and endRef are required");
          const timeoutMs = toNumber(body.timeoutMs);
          await pw.dragViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            startRef,
            endRef,
            timeoutMs: timeoutMs ?? undefined,
          });
          return res.json({ ok: true, targetId: tab.targetId });
        }
        case "select": {
          const ref = toStringOrEmpty(body.ref);
          const values = toStringArray(body.values);
          if (!ref || !values?.length)
            return jsonError(res, 400, "ref and values are required");
          const timeoutMs = toNumber(body.timeoutMs);
          await pw.selectOptionViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            ref,
            values,
            timeoutMs: timeoutMs ?? undefined,
          });
          return res.json({ ok: true, targetId: tab.targetId });
        }
        case "fill": {
          const rawFields = Array.isArray(body.fields) ? body.fields : [];
          const fields = rawFields
            .map((field) => {
              if (!field || typeof field !== "object") return null;
              const rec = field as Record<string, unknown>;
              const ref = toStringOrEmpty(rec.ref);
              const type = toStringOrEmpty(rec.type);
              if (!ref || !type) return null;
              const value =
                typeof rec.value === "string" ||
                typeof rec.value === "number" ||
                typeof rec.value === "boolean"
                  ? rec.value
                  : undefined;
              const parsed: BrowserFormField =
                value === undefined ? { ref, type } : { ref, type, value };
              return parsed;
            })
            .filter((field): field is BrowserFormField => field !== null);
          if (!fields.length) return jsonError(res, 400, "fields are required");
          const timeoutMs = toNumber(body.timeoutMs);
          await pw.fillFormViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            fields,
            timeoutMs: timeoutMs ?? undefined,
          });
          return res.json({ ok: true, targetId: tab.targetId });
        }
        case "resize": {
          const width = toNumber(body.width);
          const height = toNumber(body.height);
          if (!width || !height)
            return jsonError(res, 400, "width and height are required");
          await pw.resizeViewportViaPlaywright({
            cdpUrl,
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
          const selector = toStringOrEmpty(body.selector) || undefined;
          const url = toStringOrEmpty(body.url) || undefined;
          const loadStateRaw = toStringOrEmpty(body.loadState);
          const loadState =
            loadStateRaw === "load" ||
            loadStateRaw === "domcontentloaded" ||
            loadStateRaw === "networkidle"
              ? (loadStateRaw as "load" | "domcontentloaded" | "networkidle")
              : undefined;
          const fn = toStringOrEmpty(body.fn) || undefined;
          const timeoutMs = toNumber(body.timeoutMs) ?? undefined;
          if (
            timeMs === undefined &&
            !text &&
            !textGone &&
            !selector &&
            !url &&
            !loadState &&
            !fn
          ) {
            return jsonError(
              res,
              400,
              "wait requires at least one of: timeMs, text, textGone, selector, url, loadState, fn",
            );
          }
          await pw.waitForViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            timeMs,
            text,
            textGone,
            selector,
            url,
            loadState,
            fn,
            timeoutMs,
          });
          return res.json({ ok: true, targetId: tab.targetId });
        }
        case "evaluate": {
          const fn = toStringOrEmpty(body.fn);
          if (!fn) return jsonError(res, 400, "fn is required");
          const ref = toStringOrEmpty(body.ref) || undefined;
          const result = await pw.evaluateViaPlaywright({
            cdpUrl,
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
          await pw.closePageViaPlaywright({ cdpUrl, targetId: tab.targetId });
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
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const ref = toStringOrEmpty(body.ref) || undefined;
    const inputRef = toStringOrEmpty(body.inputRef) || undefined;
    const element = toStringOrEmpty(body.element) || undefined;
    const paths = toStringArray(body.paths) ?? [];
    const timeoutMs = toNumber(body.timeoutMs);
    if (!paths.length) return jsonError(res, 400, "paths are required");
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "file chooser hook");
      if (!pw) return;
      if (inputRef || element) {
        if (ref) {
          return jsonError(
            res,
            400,
            "ref cannot be combined with inputRef/element",
          );
        }
        await pw.setInputFilesViaPlaywright({
          cdpUrl: profileCtx.profile.cdpUrl,
          targetId: tab.targetId,
          inputRef,
          element,
          paths,
        });
      } else {
        await pw.armFileUploadViaPlaywright({
          cdpUrl: profileCtx.profile.cdpUrl,
          targetId: tab.targetId,
          paths,
          timeoutMs: timeoutMs ?? undefined,
        });
        if (ref) {
          await pw.clickViaPlaywright({
            cdpUrl: profileCtx.profile.cdpUrl,
            targetId: tab.targetId,
            ref,
          });
        }
      }
      res.json({ ok: true });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/hooks/dialog", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const accept = toBoolean(body.accept);
    const promptText = toStringOrEmpty(body.promptText) || undefined;
    const timeoutMs = toNumber(body.timeoutMs);
    if (accept === undefined) return jsonError(res, 400, "accept is required");
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "dialog hook");
      if (!pw) return;
      await pw.armDialogViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
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

  app.post("/wait/download", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const out = toStringOrEmpty(body.path) || undefined;
    const timeoutMs = toNumber(body.timeoutMs);
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "wait for download");
      if (!pw) return;
      const result = await pw.waitForDownloadViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        path: out,
        timeoutMs: timeoutMs ?? undefined,
      });
      res.json({ ok: true, targetId: tab.targetId, download: result });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/download", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const ref = toStringOrEmpty(body.ref);
    const out = toStringOrEmpty(body.path);
    const timeoutMs = toNumber(body.timeoutMs);
    if (!ref) return jsonError(res, 400, "ref is required");
    if (!out) return jsonError(res, 400, "path is required");
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "download");
      if (!pw) return;
      const result = await pw.downloadViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        ref,
        path: out,
        timeoutMs: timeoutMs ?? undefined,
      });
      res.json({ ok: true, targetId: tab.targetId, download: result });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/response/body", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const url = toStringOrEmpty(body.url);
    const timeoutMs = toNumber(body.timeoutMs);
    const maxChars = toNumber(body.maxChars);
    if (!url) return jsonError(res, 400, "url is required");
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "response body");
      if (!pw) return;
      const result = await pw.responseBodyViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        url,
        timeoutMs: timeoutMs ?? undefined,
        maxChars: maxChars ?? undefined,
      });
      res.json({ ok: true, targetId: tab.targetId, response: result });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.get("/console", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const targetId =
      typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    const level = typeof req.query.level === "string" ? req.query.level : "";

    try {
      const tab = await profileCtx.ensureTabAvailable(targetId || undefined);
      const pw = await requirePwAi(res, "console messages");
      if (!pw) return;
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
    if (!profileCtx) return;
    const targetId =
      typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    const clear = toBoolean(req.query.clear) ?? false;

    try {
      const tab = await profileCtx.ensureTabAvailable(targetId || undefined);
      const pw = await requirePwAi(res, "page errors");
      if (!pw) return;
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
    if (!profileCtx) return;
    const targetId =
      typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    const filter = typeof req.query.filter === "string" ? req.query.filter : "";
    const clear = toBoolean(req.query.clear) ?? false;

    try {
      const tab = await profileCtx.ensureTabAvailable(targetId || undefined);
      const pw = await requirePwAi(res, "network requests");
      if (!pw) return;
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
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const screenshots = toBoolean(body.screenshots) ?? undefined;
    const snapshots = toBoolean(body.snapshots) ?? undefined;
    const sources = toBoolean(body.sources) ?? undefined;
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "trace start");
      if (!pw) return;
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
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const out = toStringOrEmpty(body.path) || "";
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "trace stop");
      if (!pw) return;
      const id = crypto.randomUUID();
      const dir = "/tmp/clawdbot";
      await fs.mkdir(dir, { recursive: true });
      const tracePath = out.trim() || path.join(dir, `browser-trace-${id}.zip`);
      await pw.traceStopViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        path: tracePath,
      });
      res.json({
        ok: true,
        targetId: tab.targetId,
        path: path.resolve(tracePath),
      });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/highlight", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const ref = toStringOrEmpty(body.ref);
    if (!ref) return jsonError(res, 400, "ref is required");
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "highlight");
      if (!pw) return;
      await pw.highlightViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        ref,
      });
      res.json({ ok: true, targetId: tab.targetId });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.get("/cookies", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const targetId =
      typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId || undefined);
      const pw = await requirePwAi(res, "cookies");
      if (!pw) return;
      const result = await pw.cookiesGetViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
      });
      res.json({ ok: true, targetId: tab.targetId, ...result });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/cookies/set", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const cookie =
      body.cookie &&
      typeof body.cookie === "object" &&
      !Array.isArray(body.cookie)
        ? (body.cookie as Record<string, unknown>)
        : null;
    if (!cookie) return jsonError(res, 400, "cookie is required");
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "cookies set");
      if (!pw) return;
      await pw.cookiesSetViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        cookie: {
          name: toStringOrEmpty(cookie.name),
          value: toStringOrEmpty(cookie.value),
          url: toStringOrEmpty(cookie.url) || undefined,
          domain: toStringOrEmpty(cookie.domain) || undefined,
          path: toStringOrEmpty(cookie.path) || undefined,
          expires: toNumber(cookie.expires) ?? undefined,
          httpOnly: toBoolean(cookie.httpOnly) ?? undefined,
          secure: toBoolean(cookie.secure) ?? undefined,
          sameSite:
            cookie.sameSite === "Lax" ||
            cookie.sameSite === "None" ||
            cookie.sameSite === "Strict"
              ? (cookie.sameSite as "Lax" | "None" | "Strict")
              : undefined,
        },
      });
      res.json({ ok: true, targetId: tab.targetId });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/cookies/clear", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "cookies clear");
      if (!pw) return;
      await pw.cookiesClearViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
      });
      res.json({ ok: true, targetId: tab.targetId });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.get("/storage/:kind", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const kind = toStringOrEmpty(req.params.kind);
    if (kind !== "local" && kind !== "session")
      return jsonError(res, 400, "kind must be local|session");
    const targetId =
      typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    const key = typeof req.query.key === "string" ? req.query.key : "";
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId || undefined);
      const pw = await requirePwAi(res, "storage get");
      if (!pw) return;
      const result = await pw.storageGetViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        kind,
        key: key.trim() || undefined,
      });
      res.json({ ok: true, targetId: tab.targetId, ...result });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/storage/:kind/set", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const kind = toStringOrEmpty(req.params.kind);
    if (kind !== "local" && kind !== "session")
      return jsonError(res, 400, "kind must be local|session");
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const key = toStringOrEmpty(body.key);
    if (!key) return jsonError(res, 400, "key is required");
    const value = typeof body.value === "string" ? body.value : "";
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "storage set");
      if (!pw) return;
      await pw.storageSetViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        kind,
        key,
        value,
      });
      res.json({ ok: true, targetId: tab.targetId });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/storage/:kind/clear", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const kind = toStringOrEmpty(req.params.kind);
    if (kind !== "local" && kind !== "session")
      return jsonError(res, 400, "kind must be local|session");
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "storage clear");
      if (!pw) return;
      await pw.storageClearViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        kind,
      });
      res.json({ ok: true, targetId: tab.targetId });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/set/offline", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const offline = toBoolean(body.offline);
    if (offline === undefined)
      return jsonError(res, 400, "offline is required");
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "offline");
      if (!pw) return;
      await pw.setOfflineViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        offline,
      });
      res.json({ ok: true, targetId: tab.targetId });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/set/headers", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const headers =
      body.headers &&
      typeof body.headers === "object" &&
      !Array.isArray(body.headers)
        ? (body.headers as Record<string, unknown>)
        : null;
    if (!headers) return jsonError(res, 400, "headers is required");
    const parsed: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === "string") parsed[k] = v;
    }
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "headers");
      if (!pw) return;
      await pw.setExtraHTTPHeadersViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        headers: parsed,
      });
      res.json({ ok: true, targetId: tab.targetId });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/set/credentials", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const clear = toBoolean(body.clear) ?? false;
    const username = toStringOrEmpty(body.username) || undefined;
    const password =
      typeof body.password === "string" ? body.password : undefined;
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "http credentials");
      if (!pw) return;
      await pw.setHttpCredentialsViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        username,
        password,
        clear,
      });
      res.json({ ok: true, targetId: tab.targetId });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/set/geolocation", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const clear = toBoolean(body.clear) ?? false;
    const latitude = toNumber(body.latitude);
    const longitude = toNumber(body.longitude);
    const accuracy = toNumber(body.accuracy) ?? undefined;
    const origin = toStringOrEmpty(body.origin) || undefined;
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "geolocation");
      if (!pw) return;
      await pw.setGeolocationViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        latitude,
        longitude,
        accuracy,
        origin,
        clear,
      });
      res.json({ ok: true, targetId: tab.targetId });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/set/media", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const schemeRaw = toStringOrEmpty(body.colorScheme);
    const colorScheme =
      schemeRaw === "dark" ||
      schemeRaw === "light" ||
      schemeRaw === "no-preference"
        ? (schemeRaw as "dark" | "light" | "no-preference")
        : schemeRaw === "none"
          ? null
          : undefined;
    if (colorScheme === undefined)
      return jsonError(
        res,
        400,
        "colorScheme must be dark|light|no-preference|none",
      );
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "media emulation");
      if (!pw) return;
      await pw.emulateMediaViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        colorScheme,
      });
      res.json({ ok: true, targetId: tab.targetId });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/set/timezone", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const timezoneId = toStringOrEmpty(body.timezoneId);
    if (!timezoneId) return jsonError(res, 400, "timezoneId is required");
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "timezone");
      if (!pw) return;
      await pw.setTimezoneViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        timezoneId,
      });
      res.json({ ok: true, targetId: tab.targetId });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/set/locale", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const locale = toStringOrEmpty(body.locale);
    if (!locale) return jsonError(res, 400, "locale is required");
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "locale");
      if (!pw) return;
      await pw.setLocaleViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        locale,
      });
      res.json({ ok: true, targetId: tab.targetId });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/set/device", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const name = toStringOrEmpty(body.name);
    if (!name) return jsonError(res, 400, "name is required");
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "device emulation");
      if (!pw) return;
      await pw.setDeviceViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        name,
      });
      res.json({ ok: true, targetId: tab.targetId });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });

  app.post("/pdf", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const pw = await requirePwAi(res, "pdf");
      if (!pw) return;
      const pdf = await pw.pdfViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
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
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
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
      const tab = await profileCtx.ensureTabAvailable(targetId);
      let buffer: Buffer;
      if (ref || element) {
        const pw = await requirePwAi(res, "element/ref screenshot");
        if (!pw) return;
        const snap = await pw.takeScreenshotViaPlaywright({
          cdpUrl: profileCtx.profile.cdpUrl,
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
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) return;
    const targetId =
      typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    const format =
      req.query.format === "aria"
        ? "aria"
        : req.query.format === "ai"
          ? "ai"
          : (await getPwAiModule())
            ? "ai"
            : "aria";
    const limitRaw =
      typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const maxCharsRaw =
      typeof req.query.maxChars === "string"
        ? Number(req.query.maxChars)
        : undefined;
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
    const maxChars =
      typeof maxCharsRaw === "number" &&
      Number.isFinite(maxCharsRaw) &&
      maxCharsRaw > 0
        ? Math.floor(maxCharsRaw)
        : undefined;
    const interactive = toBoolean(req.query.interactive);
    const compact = toBoolean(req.query.compact);
    const depth = toNumber(req.query.depth);
    const selector = toStringOrEmpty(req.query.selector);
    const frameSelector = toStringOrEmpty(req.query.frame);

    try {
      const tab = await profileCtx.ensureTabAvailable(targetId || undefined);
      if (format === "ai") {
        const pw = await requirePwAi(res, "ai snapshot");
        if (!pw) return;
        const wantsRoleSnapshot =
          interactive === true ||
          compact === true ||
          depth !== undefined ||
          Boolean(selector.trim()) ||
          Boolean(frameSelector.trim());

        const snap = wantsRoleSnapshot
          ? await pw.snapshotRoleViaPlaywright({
              cdpUrl: profileCtx.profile.cdpUrl,
              targetId: tab.targetId,
              selector: selector.trim() || undefined,
              frameSelector: frameSelector.trim() || undefined,
              options: {
                interactive: interactive ?? undefined,
                compact: compact ?? undefined,
                maxDepth: depth ?? undefined,
              },
            })
          : await pw
              .snapshotAiViaPlaywright({
                cdpUrl: profileCtx.profile.cdpUrl,
                targetId: tab.targetId,
                ...(maxChars ? { maxChars } : {}),
              })
              .catch(async (err) => {
                // Public-API fallback when Playwright's private _snapshotForAI is missing.
                if (String(err).toLowerCase().includes("_snapshotforai")) {
                  return await pw.snapshotRoleViaPlaywright({
                    cdpUrl: profileCtx.profile.cdpUrl,
                    targetId: tab.targetId,
                    selector: selector.trim() || undefined,
                    frameSelector: frameSelector.trim() || undefined,
                    options: {
                      interactive: interactive ?? undefined,
                      compact: compact ?? undefined,
                      maxDepth: depth ?? undefined,
                    },
                  });
                }
                throw err;
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
