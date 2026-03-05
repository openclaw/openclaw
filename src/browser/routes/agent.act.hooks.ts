import type { BrowserRouteContext } from "../server-context.js";
import { readBody, resolveTargetIdFromBody, withPlaywrightRouteContext } from "./agent.shared.js";
import { DEFAULT_UPLOAD_DIR, resolveExistingPathsWithinRoot } from "./path-output.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError, toBoolean, toNumber, toStringArray, toStringOrEmpty } from "./utils.js";

export function registerBrowserAgentActHookRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/hooks/file-chooser", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const ref = toStringOrEmpty(body.ref) || undefined;
    const inputRef = toStringOrEmpty(body.inputRef) || undefined;
    const element = toStringOrEmpty(body.element) || undefined;
    const paths = toStringArray(body.paths) ?? [];
    const timeoutMs = toNumber(body.timeoutMs);
    if (!paths.length) {
      return jsonError(res, 400, "paths are required");
    }

    await withPlaywrightRouteContext({
      req,
      res,
      ctx,
      targetId,
      feature: "file chooser hook",
      run: async ({ cdpUrl, tab, pw }) => {
        const uploadPathsResult = await resolveExistingPathsWithinRoot({
          rootDir: DEFAULT_UPLOAD_DIR,
          requestedPaths: paths,
          scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`,
        });
        if (!uploadPathsResult.ok) {
          res.status(400).json({ error: uploadPathsResult.error });
          return;
        }
        const resolvedPaths = uploadPathsResult.paths;

        if (inputRef || element) {
          if (ref) {
            return jsonError(res, 400, "ref cannot be combined with inputRef/element");
          }
          await pw.setInputFilesViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            inputRef,
            element,
            paths: resolvedPaths,
          });
        } else {
          await pw.armFileUploadViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            paths: resolvedPaths,
            timeoutMs: timeoutMs ?? undefined,
          });
          if (ref) {
            await pw.clickViaPlaywright({
              cdpUrl,
              targetId: tab.targetId,
              ref,
            });
          }
        }
        res.json({ ok: true });
      },
    });
  });

  app.post("/hooks/dialog", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const accept = toBoolean(body.accept);
    const promptText = toStringOrEmpty(body.promptText) || undefined;
    const timeoutMs = toNumber(body.timeoutMs);
    if (accept === undefined) {
      return jsonError(res, 400, "accept is required");
    }

    await withPlaywrightRouteContext({
      req,
      res,
      ctx,
      targetId,
      feature: "dialog hook",
      run: async ({ cdpUrl, tab, pw }) => {
        await pw.armDialogViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
          accept,
          promptText,
          timeoutMs: timeoutMs ?? undefined,
        });
        res.json({ ok: true });
      },
    });
  });
}
