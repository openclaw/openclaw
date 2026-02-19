import path from "node:path";
import { ensureMediaDir, saveMediaBuffer } from "../../media/store.js";
import { captureScreenshot, snapshotAria } from "../cdp.js";
import {
  DEFAULT_AI_SNAPSHOT_EFFICIENT_DEPTH,
  DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS,
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
} from "../constants.js";
import { withBrowserNavigationPolicy } from "../navigation-guard.js";
import {
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
  normalizeBrowserScreenshot,
} from "../screenshot.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  getPwAiModule,
  handleRouteError,
  readBody,
  requirePwAi,
  resolveProfileContext,
  withPlaywrightRouteContext,
  withRouteTabContext,
} from "./agent.shared.js";
import type { BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { jsonError, toBoolean, toNumber, toStringOrEmpty } from "./utils.js";

async function saveBrowserMediaResponse(params: {
  res: BrowserResponse;
  buffer: Buffer;
  contentType: string;
  maxBytes: number;
  targetId: string;
  url: string;
}) {
  await ensureMediaDir();
  const saved = await saveMediaBuffer(
    params.buffer,
    params.contentType,
    "browser",
    params.maxBytes,
  );
  params.res.json({
    ok: true,
    path: path.resolve(saved.path),
    targetId: params.targetId,
    url: params.url,
  });
}

export function registerBrowserAgentSnapshotRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/navigate", async (req, res) => {
    const body = readBody(req);
    const url = toStringOrEmpty(body.url);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    if (!url) {
      return jsonError(res, 400, "url is required");
    }
    await withPlaywrightRouteContext({
      req,
      res,
      ctx,
      targetId,
      feature: "navigate",
      run: async ({ cdpUrl, tab, pw }) => {
        const result = await pw.navigateViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
          url,
          ...withBrowserNavigationPolicy(ctx.state().resolved.ssrfPolicy),
        });
        res.json({ ok: true, targetId: tab.targetId, ...result });
      },
    });
  });

  app.post("/pdf", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    await withPlaywrightRouteContext({
      req,
      res,
      ctx,
      targetId,
      feature: "pdf",
      run: async ({ cdpUrl, tab, pw }) => {
        const pdf = await pw.pdfViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
        });
        await saveBrowserMediaResponse({
          res,
          buffer: pdf.buffer,
          contentType: "application/pdf",
          maxBytes: pdf.buffer.byteLength,
          targetId: tab.targetId,
          url: tab.url,
        });
      },
    });
  });

  app.post("/screenshot", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const fullPage = toBoolean(body.fullPage) ?? false;
    const ref = toStringOrEmpty(body.ref) || undefined;
    const element = toStringOrEmpty(body.element) || undefined;
    const type = body.type === "jpeg" ? "jpeg" : "png";

    if (fullPage && (ref || element)) {
      return jsonError(res, 400, "fullPage is not supported for element screenshots");
    }

    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      run: async ({ profileCtx, tab, cdpUrl }) => {
        let buffer: Buffer;
        const shouldUsePlaywright =
          profileCtx.profile.driver === "extension" ||
          !tab.wsUrl ||
          Boolean(ref) ||
          Boolean(element);
        if (shouldUsePlaywright) {
          const pw = await requirePwAi(res, "screenshot");
          if (!pw) {
            return;
          }
          const snap = await pw.takeScreenshotViaPlaywright({
            cdpUrl,
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
        await saveBrowserMediaResponse({
          res,
          buffer: normalized.buffer,
          contentType: normalized.contentType ?? `image/${type}`,
          maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
          targetId: tab.targetId,
          url: tab.url,
        });
      },
    });
  });

  app.get("/snapshot", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    const targetId = typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    const mode = req.query.mode === "efficient" ? "efficient" : undefined;
    const labels = toBoolean(req.query.labels) ?? undefined;
    const explicitFormat =
      req.query.format === "aria" ? "aria" : req.query.format === "ai" ? "ai" : undefined;
    const format = explicitFormat ?? (mode ? "ai" : (await getPwAiModule()) ? "ai" : "aria");
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const hasMaxChars = Object.hasOwn(req.query, "maxChars");
    const maxCharsRaw =
      typeof req.query.maxChars === "string" ? Number(req.query.maxChars) : undefined;
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
    const maxChars =
      typeof maxCharsRaw === "number" && Number.isFinite(maxCharsRaw) && maxCharsRaw > 0
        ? Math.floor(maxCharsRaw)
        : undefined;
    const resolvedMaxChars =
      format === "ai"
        ? hasMaxChars
          ? maxChars
          : mode === "efficient"
            ? DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS
            : DEFAULT_AI_SNAPSHOT_MAX_CHARS
        : undefined;
    const interactiveRaw = toBoolean(req.query.interactive);
    const compactRaw = toBoolean(req.query.compact);
    const depthRaw = toNumber(req.query.depth);
    const refsModeRaw = toStringOrEmpty(req.query.refs).trim();
    const refsMode: "aria" | "role" | undefined =
      refsModeRaw === "aria" ? "aria" : refsModeRaw === "role" ? "role" : undefined;
    const interactive = interactiveRaw ?? (mode === "efficient" ? true : undefined);
    const compact = compactRaw ?? (mode === "efficient" ? true : undefined);
    const depth =
      depthRaw ?? (mode === "efficient" ? DEFAULT_AI_SNAPSHOT_EFFICIENT_DEPTH : undefined);
    const selector = toStringOrEmpty(req.query.selector);
    const frameSelector = toStringOrEmpty(req.query.frame);
    const selectorValue = selector.trim() || undefined;
    const frameSelectorValue = frameSelector.trim() || undefined;

    try {
      const tab = await profileCtx.ensureTabAvailable(targetId || undefined);
      if ((labels || mode === "efficient") && format === "aria") {
        return jsonError(res, 400, "labels/mode=efficient require format=ai");
      }
      if (format === "ai") {
        const pw = await requirePwAi(res, "ai snapshot");
        if (!pw) {
          return;
        }
        const wantsRoleSnapshot =
          labels === true ||
          mode === "efficient" ||
          interactive === true ||
          compact === true ||
          depth !== undefined ||
          Boolean(selectorValue) ||
          Boolean(frameSelectorValue);
        const roleSnapshotArgs = {
          cdpUrl: profileCtx.profile.cdpUrl,
          targetId: tab.targetId,
          selector: selectorValue,
          frameSelector: frameSelectorValue,
          refsMode,
          options: {
            interactive: interactive ?? undefined,
            compact: compact ?? undefined,
            maxDepth: depth ?? undefined,
          },
        };

        const snap = wantsRoleSnapshot
          ? await pw.snapshotRoleViaPlaywright(roleSnapshotArgs)
          : await pw
              .snapshotAiViaPlaywright({
                cdpUrl: profileCtx.profile.cdpUrl,
                targetId: tab.targetId,
                ...(typeof resolvedMaxChars === "number" ? { maxChars: resolvedMaxChars } : {}),
              })
              .catch(async (err) => {
                // Public-API fallback when Playwright's private _snapshotForAI is missing.
                if (String(err).toLowerCase().includes("_snapshotforai")) {
                  return await pw.snapshotRoleViaPlaywright(roleSnapshotArgs);
                }
                throw err;
              });
        if (labels) {
          const labeled = await pw.screenshotWithLabelsViaPlaywright({
            cdpUrl: profileCtx.profile.cdpUrl,
            targetId: tab.targetId,
            refs: "refs" in snap ? snap.refs : {},
            type: "png",
          });
          const normalized = await normalizeBrowserScreenshot(labeled.buffer, {
            maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
            maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
          });
          await ensureMediaDir();
          const saved = await saveMediaBuffer(
            normalized.buffer,
            normalized.contentType ?? "image/png",
            "browser",
            DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
          );
          const imageType = normalized.contentType?.includes("jpeg") ? "jpeg" : "png";
          return res.json({
            ok: true,
            format,
            targetId: tab.targetId,
            url: tab.url,
            labels: true,
            labelsCount: labeled.labels,
            labelsSkipped: labeled.skipped,
            imagePath: path.resolve(saved.path),
            imageType,
            ...snap,
          });
        }

        return res.json({
          ok: true,
          format,
          targetId: tab.targetId,
          url: tab.url,
          ...snap,
        });
      }

      const snap =
        profileCtx.profile.driver === "extension" || !tab.wsUrl
          ? (() => {
              // Extension relay doesn't expose per-page WS URLs; run AX snapshot via Playwright CDP session.
              // Also covers cases where wsUrl is missing/unusable.
              return requirePwAi(res, "aria snapshot").then(async (pw) => {
                if (!pw) {
                  return null;
                }
                return await pw.snapshotAriaViaPlaywright({
                  cdpUrl: profileCtx.profile.cdpUrl,
                  targetId: tab.targetId,
                  limit,
                });
              });
            })()
          : snapshotAria({ wsUrl: tab.wsUrl ?? "", limit });

      const resolved = await Promise.resolve(snap);
      if (!resolved) {
        return;
      }
      return res.json({
        ok: true,
        format,
        targetId: tab.targetId,
        url: tab.url,
        ...resolved,
      });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });
}
