import type express from "express";

import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { getProfileContext, jsonError } from "./utils.js";

export const SELECTOR_UNSUPPORTED_MESSAGE = [
  "Error: 'selector' is not supported. Use 'ref' from snapshot instead.",
  "",
  "Example workflow:",
  "1. snapshot action to get page state with refs",
  '2. act with ref: "e123" to interact with element',
  "",
  "This is more reliable for modern SPAs.",
].join("\n");

export function readBody(req: express.Request): Record<string, unknown> {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return body;
}

export function handleRouteError(
  ctx: BrowserRouteContext,
  res: express.Response,
  err: unknown,
) {
  const mapped = ctx.mapTabError(err);
  if (mapped) return jsonError(res, mapped.status, mapped.message);
  jsonError(res, 500, String(err));
}

export function resolveProfileContext(
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

export type PwAiModule = typeof import("../pw-ai.js");

let pwAiModule: Promise<PwAiModule | null> | null = null;

export async function getPwAiModule(): Promise<PwAiModule | null> {
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

export async function requirePwAi(
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
