import type { BrowserRouteContext } from "../server-context.js";
import {
  readBody,
  requirePwAi,
  resolveTargetIdFromBody,
  withRouteTabContext,
} from "./agent.shared.js";
import { ensureOutputRootDir, resolveWritableOutputPathOrRespond } from "./output-paths.js";
import { DEFAULT_DOWNLOAD_DIR } from "./path-output.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError, toNumber, toStringOrEmpty } from "./utils.js";

function buildDownloadRequestBase(cdpUrl: string, targetId: string, timeoutMs: number | undefined) {
  return {
    cdpUrl,
    targetId,
    timeoutMs: timeoutMs ?? undefined,
  };
}

export function registerBrowserAgentActDownloadRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/wait/download", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const out = toStringOrEmpty(body.path) || "";
    const timeoutMs = toNumber(body.timeoutMs);

    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      run: async ({ profileCtx, cdpUrl, tab }) => {
        if (profileCtx.profile.driver === "existing-session") {
          return jsonError(
            res,
            501,
            "download waiting is not supported for existing-session profiles yet.",
          );
        }
        const pw = await requirePwAi(res, "wait for download");
        if (!pw) {
          return;
        }
        await ensureOutputRootDir(DEFAULT_DOWNLOAD_DIR);
        let downloadPath: string | undefined;
        if (out.trim()) {
          const resolvedDownloadPath = await resolveWritableOutputPathOrRespond({
            res,
            rootDir: DEFAULT_DOWNLOAD_DIR,
            requestedPath: out,
            scopeLabel: "downloads directory",
          });
          if (!resolvedDownloadPath) {
            return;
          }
          downloadPath = resolvedDownloadPath;
        }
        const requestBase = buildDownloadRequestBase(cdpUrl, tab.targetId, timeoutMs);
        const result = await pw.waitForDownloadViaPlaywright({
          ...requestBase,
          path: downloadPath,
        });
        res.json({ ok: true, targetId: tab.targetId, download: result });
      },
    });
  });

  app.post("/download", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const ref = toStringOrEmpty(body.ref);
    const out = toStringOrEmpty(body.path);
    const timeoutMs = toNumber(body.timeoutMs);
    if (!ref) {
      return jsonError(res, 400, "ref is required");
    }
    if (!out) {
      return jsonError(res, 400, "path is required");
    }

    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      run: async ({ profileCtx, cdpUrl, tab }) => {
        if (profileCtx.profile.driver === "existing-session") {
          return jsonError(
            res,
            501,
            "downloads are not supported for existing-session profiles yet.",
          );
        }
        const pw = await requirePwAi(res, "download");
        if (!pw) {
          return;
        }
        await ensureOutputRootDir(DEFAULT_DOWNLOAD_DIR);
        const downloadPath = await resolveWritableOutputPathOrRespond({
          res,
          rootDir: DEFAULT_DOWNLOAD_DIR,
          requestedPath: out,
          scopeLabel: "downloads directory",
        });
        if (!downloadPath) {
          return;
        }
        const requestBase = buildDownloadRequestBase(cdpUrl, tab.targetId, timeoutMs);
        const result = await pw.downloadViaPlaywright({
          ...requestBase,
          ref,
          path: downloadPath,
        });
        res.json({ ok: true, targetId: tab.targetId, download: result });
      },
    });
  });
}
