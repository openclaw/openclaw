import { toBrowserErrorResponse } from "../errors.js";
import type { PwAiModule } from "../pw-ai-module.js";
import { getPwAiModule as getPwAiModuleBase } from "../pw-ai-module.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import type { BrowserRequest, BrowserResponse } from "./types.js";
import { getProfileContext, jsonError } from "./utils.js";

/**
 * Enrich a tab-targeting response body with targetId and URL.
 * Pure function — no side effects, no I/O. Mutates `body` in place.
 *
 * @returns true if enrichment was applied, false if body was not eligible.
 */
export function enrichTabResponseBody(
  body: unknown,
  tab: { targetId: string; url?: string },
  postRunUrl?: string,
): boolean {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    (body as Record<string, unknown>).ok !== true
  ) {
    return false;
  }
  const record = body as Record<string, unknown>;
  if (record.targetId === undefined) {
    record.targetId = tab.targetId;
  }
  if (record.url === undefined) {
    const resolvedUrl = postRunUrl || tab.url;
    if (resolvedUrl) {
      record.url = resolvedUrl;
    }
  }
  return true;
}

export const SELECTOR_UNSUPPORTED_MESSAGE = [
  "Error: 'selector' is not supported. Use 'ref' from snapshot instead.",
  "",
  "Example workflow:",
  "1. snapshot action to get page state with refs",
  '2. act with ref: "e123" to interact with element',
  "",
  "This is more reliable for modern SPAs.",
].join("\n");

export function readBody(req: BrowserRequest): Record<string, unknown> {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  return body;
}

export function resolveTargetIdFromBody(body: Record<string, unknown>): string | undefined {
  const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
  return targetId || undefined;
}

export function resolveTargetIdFromQuery(query: Record<string, unknown>): string | undefined {
  const targetId = typeof query.targetId === "string" ? query.targetId.trim() : "";
  return targetId || undefined;
}

export function handleRouteError(ctx: BrowserRouteContext, res: BrowserResponse, err: unknown) {
  const mapped = ctx.mapTabError(err);
  if (mapped) {
    return jsonError(res, mapped.status, mapped.message);
  }
  const browserMapped = toBrowserErrorResponse(err);
  if (browserMapped) {
    return jsonError(res, browserMapped.status, browserMapped.message);
  }
  jsonError(res, 500, String(err));
}

export function resolveProfileContext(
  req: BrowserRequest,
  res: BrowserResponse,
  ctx: BrowserRouteContext,
): ProfileContext | null {
  const profileCtx = getProfileContext(req, ctx);
  if ("error" in profileCtx) {
    jsonError(res, profileCtx.status, profileCtx.error);
    return null;
  }
  return profileCtx;
}

export async function getPwAiModule(): Promise<PwAiModule | null> {
  return await getPwAiModuleBase({ mode: "soft" });
}

export async function requirePwAi(
  res: BrowserResponse,
  feature: string,
): Promise<PwAiModule | null> {
  const mod = await getPwAiModule();
  if (mod) {
    return mod;
  }
  jsonError(
    res,
    501,
    [
      `Playwright is not available in this gateway build; '${feature}' is unsupported.`,
      "Install the full Playwright package (not playwright-core) and restart the gateway, or reinstall with browser support.",
      "Docs: /tools/browser#playwright-requirement",
    ].join("\n"),
  );
  return null;
}

type RouteTabContext = {
  profileCtx: ProfileContext;
  tab: Awaited<ReturnType<ProfileContext["ensureTabAvailable"]>>;
  cdpUrl: string;
};

type RouteTabPwContext = RouteTabContext & {
  pw: PwAiModule;
};

type RouteWithTabParams<T> = {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  targetId?: string;
  run: (ctx: RouteTabContext) => Promise<T>;
};

export async function withRouteTabContext<T>(
  params: RouteWithTabParams<T>,
): Promise<T | undefined> {
  const profileCtx = resolveProfileContext(params.req, params.res, params.ctx);
  if (!profileCtx) {
    return undefined;
  }
  try {
    const tab = await profileCtx.ensureTabAvailable(params.targetId);

    // Enrich every successful tab-targeting response with the current page URL.
    // This gives downstream consumers (security plugins, audit loggers, etc.)
    // a consistent way to know which page was targeted without issuing a
    // separate tabs query.  Existing explicit handler values win; the wrapper
    // only fills in missing fields.
    //
    // URL resolution happens *after* the handler runs so that actions which
    // navigate (e.g. /act, /navigate) report the post-action URL, not a stale
    // pre-run snapshot.  We avoid a pre-run Playwright page lookup here to
    // prevent doubling CDP connection latency — handlers that need a page
    // already resolve one themselves.

    // Capture original json so we can intercept after run() completes.
    const originalJson = params.res.json.bind(params.res);
    let interceptedBody: unknown = undefined;
    let jsonCalled = false;
    params.res.json = (body: unknown) => {
      interceptedBody = body;
      jsonCalled = true;
      // Don't send yet — we'll enrich and send after run().
      return params.res;
    };

    let result: T | undefined;
    try {
      result = await params.run({
        profileCtx,
        tab,
        cdpUrl: profileCtx.profile.cdpUrl,
      });
    } catch (runErr) {
      // Restore original res.json so error handling can actually send.
      params.res.json = originalJson;
      throw runErr;
    }

    // Now enrich and flush the intercepted response body.
    if (jsonCalled) {
      // Resolve live URL *after* the handler ran, so navigating actions
      // report the post-action URL.  Try Playwright first (actual page
      // state), fall back to tab metadata URL.
      let postRunUrl: string | undefined;
      try {
        const pwMod = await getPwAiModuleBase({ mode: "soft" });
        if (pwMod?.getPageForTargetId) {
          const page = await pwMod.getPageForTargetId({
            cdpUrl: profileCtx.profile.cdpUrl,
            targetId: tab.targetId,
          });
          if (page) {
            postRunUrl = page.url();
          }
        }
      } catch {
        // Playwright unavailable — fall back to tab.url
      }
      enrichTabResponseBody(interceptedBody, tab, postRunUrl);
      // Restore res.json before flushing so that if originalJson throws
      // (e.g. BigInt serialization), the outer catch can still send errors.
      params.res.json = originalJson;
      originalJson(interceptedBody);
    }

    return result;
  } catch (err) {
    handleRouteError(params.ctx, params.res, err);
    return undefined;
  }
}

type RouteWithPwParams<T> = {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  targetId?: string;
  feature: string;
  run: (ctx: RouteTabPwContext) => Promise<T>;
};

export async function withPlaywrightRouteContext<T>(
  params: RouteWithPwParams<T>,
): Promise<T | undefined> {
  return await withRouteTabContext({
    req: params.req,
    res: params.res,
    ctx: params.ctx,
    targetId: params.targetId,
    run: async ({ profileCtx, tab, cdpUrl }) => {
      const pw = await requirePwAi(params.res, params.feature);
      if (!pw) {
        return undefined as T | undefined;
      }
      return await params.run({ profileCtx, tab, cdpUrl, pw });
    },
  });
}
