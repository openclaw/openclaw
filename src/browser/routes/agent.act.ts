import type { BrowserFormField } from "../client-actions-core.js";
import { normalizeBrowserFormField } from "../form-fields.js";
import type { BrowserRouteContext } from "../server-context.js";
import { registerBrowserAgentActDownloadRoutes } from "./agent.act.download.js";
import { registerBrowserAgentActHookRoutes } from "./agent.act.hooks.js";
import {
  type ActKind,
  isActKind,
  parseClickButton,
  parseClickModifiers,
} from "./agent.act.shared.js";
import {
  readBody,
  resolveTargetIdFromBody,
  withPlaywrightRouteContext,
  SELECTOR_UNSUPPORTED_MESSAGE,
} from "./agent.shared.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError, toBoolean, toNumber, toStringArray, toStringOrEmpty } from "./utils.js";

export function registerBrowserAgentActRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/act", async (req, res) => {
    const body = readBody(req);
    const kindRaw = toStringOrEmpty(body.kind);
    if (!isActKind(kindRaw)) {
      return jsonError(res, 400, "kind is required");
    }
    const kind: ActKind = kindRaw;
    const targetId = resolveTargetIdFromBody(body);
    if (Object.hasOwn(body, "selector") && kind !== "wait") {
      return jsonError(res, 400, SELECTOR_UNSUPPORTED_MESSAGE);
    }

    await withPlaywrightRouteContext({
      req,
      res,
      ctx,
      targetId,
      feature: `act:${kind}`,
      run: async ({ cdpUrl, tab, pw }) => {
        const evaluateEnabled = ctx.state().resolved.evaluateEnabled;

        switch (kind) {
          case "click": {
            const ref = toStringOrEmpty(body.ref);
            if (!ref) {
              return jsonError(res, 400, "ref is required");
            }
            const doubleClick = toBoolean(body.doubleClick) ?? false;
            const timeoutMs = toNumber(body.timeoutMs);
            const buttonRaw = toStringOrEmpty(body.button) || "";
            const button = buttonRaw ? parseClickButton(buttonRaw) : undefined;
            if (buttonRaw && !button) {
              return jsonError(res, 400, "button must be left|right|middle");
            }

            const modifiersRaw = toStringArray(body.modifiers) ?? [];
            const parsedModifiers = parseClickModifiers(modifiersRaw);
            if (parsedModifiers.error) {
              return jsonError(res, 400, parsedModifiers.error);
            }
            const modifiers = parsedModifiers.modifiers;
            const clickRequest: Parameters<typeof pw.clickViaPlaywright>[0] = {
              cdpUrl,
              targetId: tab.targetId,
              ref,
              doubleClick,
            };
            if (button) {
              clickRequest.button = button;
            }
            if (modifiers) {
              clickRequest.modifiers = modifiers;
            }
            if (timeoutMs) {
              clickRequest.timeoutMs = timeoutMs;
            }
            await pw.clickViaPlaywright(clickRequest);
            return res.json({ ok: true, targetId: tab.targetId, url: tab.url });
          }
          case "type": {
            const ref = toStringOrEmpty(body.ref);
            if (!ref) {
              return jsonError(res, 400, "ref is required");
            }
            if (typeof body.text !== "string") {
              return jsonError(res, 400, "text is required");
            }
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
            if (timeoutMs) {
              typeRequest.timeoutMs = timeoutMs;
            }
            await pw.typeViaPlaywright(typeRequest);
            return res.json({ ok: true, targetId: tab.targetId });
          }
          case "press": {
            const key = toStringOrEmpty(body.key);
            if (!key) {
              return jsonError(res, 400, "key is required");
            }
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
            if (!ref) {
              return jsonError(res, 400, "ref is required");
            }
            const timeoutMs = toNumber(body.timeoutMs);
            await pw.hoverViaPlaywright({
              cdpUrl,
              targetId: tab.targetId,
              ref,
              timeoutMs: timeoutMs ?? undefined,
            });
            return res.json({ ok: true, targetId: tab.targetId });
          }
          case "scrollIntoView": {
            const ref = toStringOrEmpty(body.ref);
            if (!ref) {
              return jsonError(res, 400, "ref is required");
            }
            const timeoutMs = toNumber(body.timeoutMs);
            const scrollRequest: Parameters<typeof pw.scrollIntoViewViaPlaywright>[0] = {
              cdpUrl,
              targetId: tab.targetId,
              ref,
            };
            if (timeoutMs) {
              scrollRequest.timeoutMs = timeoutMs;
            }
            await pw.scrollIntoViewViaPlaywright(scrollRequest);
            return res.json({ ok: true, targetId: tab.targetId });
          }
          case "drag": {
            const startRef = toStringOrEmpty(body.startRef);
            const endRef = toStringOrEmpty(body.endRef);
            if (!startRef || !endRef) {
              return jsonError(res, 400, "startRef and endRef are required");
            }
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
            if (!ref || !values?.length) {
              return jsonError(res, 400, "ref and values are required");
            }
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
                if (!field || typeof field !== "object") {
                  return null;
                }
                return normalizeBrowserFormField(field as Record<string, unknown>);
              })
              .filter((field): field is BrowserFormField => field !== null);
            if (!fields.length) {
              return jsonError(res, 400, "fields are required");
            }
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
            if (!width || !height) {
              return jsonError(res, 400, "width and height are required");
            }
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
                ? loadStateRaw
                : undefined;
            const fn = toStringOrEmpty(body.fn) || undefined;
            const timeoutMs = toNumber(body.timeoutMs) ?? undefined;
            if (fn && !evaluateEnabled) {
              return jsonError(
                res,
                403,
                [
                  "wait --fn is disabled by config (browser.evaluateEnabled=false).",
                  "Docs: /gateway/configuration#browser-openclaw-managed-browser",
                ].join("\n"),
              );
            }
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
            if (!evaluateEnabled) {
              return jsonError(
                res,
                403,
                [
                  "act:evaluate is disabled by config (browser.evaluateEnabled=false).",
                  "Docs: /gateway/configuration#browser-openclaw-managed-browser",
                ].join("\n"),
              );
            }
            const fn = toStringOrEmpty(body.fn);
            if (!fn) {
              return jsonError(res, 400, "fn is required");
            }
            const ref = toStringOrEmpty(body.ref) || undefined;
            const evalTimeoutMs = toNumber(body.timeoutMs);
            const evalRequest: Parameters<typeof pw.evaluateViaPlaywright>[0] = {
              cdpUrl,
              targetId: tab.targetId,
              fn,
              ref,
              signal: req.signal,
            };
            if (evalTimeoutMs !== undefined) {
              evalRequest.timeoutMs = evalTimeoutMs;
            }
            const result = await pw.evaluateViaPlaywright(evalRequest);
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
      },
    });
  });

  registerBrowserAgentActHookRoutes(app, ctx);
  registerBrowserAgentActDownloadRoutes(app, ctx);

  app.post("/response/body", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const url = toStringOrEmpty(body.url);
    const timeoutMs = toNumber(body.timeoutMs);
    const maxChars = toNumber(body.maxChars);
    if (!url) {
      return jsonError(res, 400, "url is required");
    }

    await withPlaywrightRouteContext({
      req,
      res,
      ctx,
      targetId,
      feature: "response body",
      run: async ({ cdpUrl, tab, pw }) => {
        const result = await pw.responseBodyViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
          url,
          timeoutMs: timeoutMs ?? undefined,
          maxChars: maxChars ?? undefined,
        });
        res.json({ ok: true, targetId: tab.targetId, response: result });
      },
    });
  });

  app.post("/highlight", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const ref = toStringOrEmpty(body.ref);
    if (!ref) {
      return jsonError(res, 400, "ref is required");
    }

    await withPlaywrightRouteContext({
      req,
      res,
      ctx,
      targetId,
      feature: "highlight",
      run: async ({ cdpUrl, tab, pw }) => {
        await pw.highlightViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
          ref,
        });
        res.json({ ok: true, targetId: tab.targetId });
      },
    });
  });
}
