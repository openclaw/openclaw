import {
  clickChromeMcpElement,
  closeChromeMcpTab,
  dragChromeMcpElement,
  evaluateChromeMcpScript,
  fillChromeMcpElement,
  fillChromeMcpForm,
  hoverChromeMcpElement,
  pressChromeMcpKey,
  resizeChromeMcpPage,
} from "../chrome-mcp.js";
import type { BrowserFormField } from "../client-actions-core.js";
import { normalizeBrowserFormField } from "../form-fields.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { BrowserRouteContext } from "../server-context.js";
import { matchBrowserUrlPattern } from "../url-pattern.js";
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
  requirePwAi,
  resolveTargetIdFromBody,
  withRouteTabContext,
  SELECTOR_UNSUPPORTED_MESSAGE,
} from "./agent.shared.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError, toBoolean, toNumber, toStringArray, toStringOrEmpty } from "./utils.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function browserEvaluateDisabledMessage(action: "wait" | "evaluate"): string {
  return [
    action === "wait"
      ? "wait --fn is disabled by config (browser.evaluateEnabled=false)."
      : "act:evaluate is disabled by config (browser.evaluateEnabled=false).",
    "Docs: /gateway/configuration#browser-openclaw-managed-browser",
  ].join("\n");
}

function buildExistingSessionWaitPredicate(params: {
  text?: string;
  textGone?: string;
  selector?: string;
  loadState?: "load" | "domcontentloaded" | "networkidle";
  fn?: string;
}): string | null {
  const checks: string[] = [];
  if (params.text) {
    checks.push(`Boolean(document.body?.innerText?.includes(${JSON.stringify(params.text)}))`);
  }
  if (params.textGone) {
    checks.push(`!document.body?.innerText?.includes(${JSON.stringify(params.textGone)})`);
  }
  if (params.selector) {
    checks.push(`Boolean(document.querySelector(${JSON.stringify(params.selector)}))`);
  }
  if (params.loadState === "domcontentloaded") {
    checks.push(`document.readyState === "interactive" || document.readyState === "complete"`);
  } else if (params.loadState === "load") {
    checks.push(`document.readyState === "complete"`);
  }
  if (params.fn) {
    checks.push(`Boolean(await (${params.fn})())`);
  }
  if (checks.length === 0) {
    return null;
  }
  return checks.length === 1 ? checks[0] : checks.map((check) => `(${check})`).join(" && ");
}

async function waitForExistingSessionCondition(params: {
  profileName: string;
  targetId: string;
  timeMs?: number;
  text?: string;
  textGone?: string;
  selector?: string;
  url?: string;
  loadState?: "load" | "domcontentloaded" | "networkidle";
  fn?: string;
  timeoutMs?: number;
}): Promise<void> {
  if (params.timeMs && params.timeMs > 0) {
    await sleep(params.timeMs);
  }
  const predicate = buildExistingSessionWaitPredicate(params);
  if (!predicate && !params.url) {
    return;
  }
  const timeoutMs = Math.max(250, params.timeoutMs ?? 10_000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let ready = true;
    if (predicate) {
      ready = Boolean(
        await evaluateChromeMcpScript({
          profileName: params.profileName,
          targetId: params.targetId,
          fn: `async () => ${predicate}`,
        }),
      );
    }
    if (ready && params.url) {
      const currentUrl = await evaluateChromeMcpScript({
        profileName: params.profileName,
        targetId: params.targetId,
        fn: "() => window.location.href",
      });
      ready = typeof currentUrl === "string" && matchBrowserUrlPattern(params.url, currentUrl);
    }
    if (ready) {
      return;
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for condition");
}

const SELECTOR_ALLOWED_KINDS: ReadonlySet<string> = new Set([
  "click",
  "drag",
  "hover",
  "scrollIntoView",
  "select",
  "type",
  "wait",
]);

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
    if (Object.hasOwn(body, "selector") && !SELECTOR_ALLOWED_KINDS.has(kind)) {
      return jsonError(res, 400, SELECTOR_UNSUPPORTED_MESSAGE);
    }
    const earlyFn = kind === "wait" || kind === "evaluate" ? toStringOrEmpty(body.fn) : "";
    if (
      (kind === "evaluate" || (kind === "wait" && earlyFn)) &&
      !ctx.state().resolved.evaluateEnabled
    ) {
      return jsonError(
        res,
        403,
        browserEvaluateDisabledMessage(kind === "evaluate" ? "evaluate" : "wait"),
      );
    }

    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      run: async ({ profileCtx, cdpUrl, tab }) => {
        const evaluateEnabled = ctx.state().resolved.evaluateEnabled;
        const isExistingSession = getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp;
        const profileName = profileCtx.profile.name;

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
            if (isExistingSession) {
              if ((button && button !== "left") || (modifiers && modifiers.length > 0)) {
                return jsonError(
                  res,
                  501,
                  "existing-session click currently supports left-click only (no button overrides/modifiers).",
                );
              }
              await clickChromeMcpElement({
                profileName,
                targetId: tab.targetId,
                uid: ref,
                doubleClick,
              });
              return res.json({ ok: true, targetId: tab.targetId, url: tab.url });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            const clickRequest: Parameters<typeof pw.clickViaPlaywright>[0] = {
              cdpUrl,
              targetId: tab.targetId,
              ref,
              doubleClick,
              button,
              modifiers,
              timeoutMs: timeoutMs ?? undefined,
            };
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
            if (isExistingSession) {
              if (slowly) {
                return jsonError(
                  res,
                  501,
                  "existing-session type does not support slowly=true; use fill/press instead.",
                );
              }
              await fillChromeMcpElement({
                profileName,
                targetId: tab.targetId,
                uid: ref,
                value: text,
              });
              if (submit) {
                await pressChromeMcpKey({
                  profileName,
                  targetId: tab.targetId,
                  key: "Enter",
                });
              }
              return res.json({ ok: true, targetId: tab.targetId });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            const typeRequest: Parameters<typeof pw.typeViaPlaywright>[0] = {
              cdpUrl,
              targetId: tab.targetId,
              ref,
              text,
              submit,
              slowly,
              timeoutMs: timeoutMs ?? undefined,
            };
            await pw.typeViaPlaywright(typeRequest);
            return res.json({ ok: true, targetId: tab.targetId });
          }
          case "press": {
            const key = toStringOrEmpty(body.key);
            if (!key) {
              return jsonError(res, 400, "key is required");
            }
            const delayMs = toNumber(body.delayMs);
            if (isExistingSession) {
              if (delayMs) {
                return jsonError(res, 501, "existing-session press does not support delayMs.");
              }
              await pressChromeMcpKey({ profileName, targetId: tab.targetId, key });
              return res.json({ ok: true, targetId: tab.targetId });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
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
            if (isExistingSession) {
              if (timeoutMs) {
                return jsonError(
                  res,
                  501,
                  "existing-session hover does not support timeoutMs overrides.",
                );
              }
              await hoverChromeMcpElement({ profileName, targetId: tab.targetId, uid: ref });
              return res.json({ ok: true, targetId: tab.targetId });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
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
            if (isExistingSession) {
              if (timeoutMs) {
                return jsonError(
                  res,
                  501,
                  "existing-session scrollIntoView does not support timeoutMs overrides.",
                );
              }
              await evaluateChromeMcpScript({
                profileName,
                targetId: tab.targetId,
                fn: `(el) => { el.scrollIntoView({ block: "center", inline: "center" }); return true; }`,
                args: [ref],
              });
              return res.json({ ok: true, targetId: tab.targetId });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            await pw.scrollIntoViewViaPlaywright({
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
            if (!startRef) {
              return jsonError(res, 400, "startRef is required");
            }
            if (!endRef) {
              return jsonError(res, 400, "endRef is required");
            }
            const timeoutMs = toNumber(body.timeoutMs);
            if (isExistingSession) {
              if (timeoutMs) {
                return jsonError(
                  res,
                  501,
                  "existing-session drag does not support timeoutMs overrides.",
                );
              }
              await dragChromeMcpElement({
                profileName,
                targetId: tab.targetId,
                fromUid: startRef,
                toUid: endRef,
              });
              return res.json({ ok: true, targetId: tab.targetId });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
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
            if (!ref) {
              return jsonError(res, 400, "ref is required");
            }
            const values = toStringArray(body.values);
            if (!values?.length) {
              return jsonError(res, 400, "values are required");
            }
            const timeoutMs = toNumber(body.timeoutMs);
            if (isExistingSession) {
              if (values.length !== 1) {
                return jsonError(
                  res,
                  501,
                  "existing-session select currently supports a single value only.",
                );
              }
              if (timeoutMs) {
                return jsonError(
                  res,
                  501,
                  "existing-session select does not support timeoutMs overrides.",
                );
              }
              await fillChromeMcpElement({
                profileName,
                targetId: tab.targetId,
                uid: ref,
                value: values[0] ?? "",
              });
              return res.json({ ok: true, targetId: tab.targetId });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
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
            if (isExistingSession) {
              if (timeoutMs) {
                return jsonError(
                  res,
                  501,
                  "existing-session fill does not support timeoutMs overrides.",
                );
              }
              await fillChromeMcpForm({
                profileName,
                targetId: tab.targetId,
                elements: fields.map((field) => ({
                  uid: field.ref,
                  value: String(field.value ?? ""),
                })),
              });
              return res.json({ ok: true, targetId: tab.targetId });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
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
            if (isExistingSession) {
              await resizeChromeMcpPage({
                profileName,
                targetId: tab.targetId,
                width,
                height,
              });
              return res.json({ ok: true, targetId: tab.targetId, url: tab.url });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
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
              return jsonError(res, 403, browserEvaluateDisabledMessage("wait"));
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
            if (isExistingSession) {
              if (loadState === "networkidle") {
                return jsonError(
                  res,
                  501,
                  "existing-session wait does not support loadState=networkidle yet.",
                );
              }
              await waitForExistingSessionCondition({
                profileName,
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
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
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
              return jsonError(res, 403, browserEvaluateDisabledMessage("evaluate"));
            }
            const fn = toStringOrEmpty(body.fn);
            if (!fn) {
              return jsonError(res, 400, "fn is required");
            }
            const ref = toStringOrEmpty(body.ref) || undefined;
            const evalTimeoutMs = toNumber(body.timeoutMs);
            if (isExistingSession) {
              if (evalTimeoutMs !== undefined) {
                return jsonError(
                  res,
                  501,
                  "existing-session evaluate does not support timeoutMs overrides.",
                );
              }
              const result = await evaluateChromeMcpScript({
                profileName,
                targetId: tab.targetId,
                fn,
                args: ref ? [ref] : undefined,
              });
              return res.json({
                ok: true,
                targetId: tab.targetId,
                url: tab.url,
                result,
              });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
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
            if (isExistingSession) {
              await closeChromeMcpTab(profileName, tab.targetId);
              return res.json({ ok: true, targetId: tab.targetId });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            await pw.closePageViaPlaywright({ cdpUrl, targetId: tab.targetId });
            return res.json({ ok: true, targetId: tab.targetId });
          }
          case "batch": {
            return jsonError(
              res,
              501,
              "batch actions are temporarily unavailable; please send actions individually.",
            );
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

    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      run: async ({ profileCtx, cdpUrl, tab }) => {
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          return jsonError(
            res,
            501,
            "response body is not supported for existing-session profiles yet.",
          );
        }
        const pw = await requirePwAi(res, "response body");
        if (!pw) {
          return;
        }
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

    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      run: async ({ profileCtx, cdpUrl, tab }) => {
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          await evaluateChromeMcpScript({
            profileName: profileCtx.profile.name,
            targetId: tab.targetId,
            args: [ref],
            fn: `(el) => {
              if (!(el instanceof Element)) {
                return false;
              }
              el.scrollIntoView({ block: "center", inline: "center" });
              const previousOutline = el.style.outline;
              const previousOffset = el.style.outlineOffset;
              el.style.outline = "3px solid #FF4500";
              el.style.outlineOffset = "2px";
              setTimeout(() => {
                el.style.outline = previousOutline;
                el.style.outlineOffset = previousOffset;
              }, 2000);
              return true;
            }`,
          });
          return res.json({ ok: true, targetId: tab.targetId });
        }
        const pw = await requirePwAi(res, "highlight");
        if (!pw) {
          return;
        }
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
