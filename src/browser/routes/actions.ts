import type express from "express";

import type { BrowserRouteContext } from "../server-context.js";
import { handleBrowserActionCore } from "./actions-core.js";
import { handleBrowserActionExtra } from "./actions-extra.js";
import { jsonError, toStringOrEmpty } from "./utils.js";

function readBody(req: express.Request): Record<string, unknown> {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return body;
}

function readTargetId(value: unknown): string {
  return toStringOrEmpty(value);
}

function handleActionError(
  ctx: BrowserRouteContext,
  res: express.Response,
  err: unknown,
) {
  const mapped = ctx.mapTabError(err);
  if (mapped) return jsonError(res, mapped.status, mapped.message);
  jsonError(res, 500, String(err));
}

async function runCoreAction(
  ctx: BrowserRouteContext,
  res: express.Response,
  action: Parameters<typeof handleBrowserActionCore>[0]["action"],
  args: Record<string, unknown>,
  targetId: string,
) {
  try {
    const cdpPort = ctx.state().cdpPort;
    await handleBrowserActionCore({
      action,
      args,
      targetId,
      cdpPort,
      ctx,
      res,
    });
  } catch (err) {
    handleActionError(ctx, res, err);
  }
}

async function runExtraAction(
  ctx: BrowserRouteContext,
  res: express.Response,
  action: Parameters<typeof handleBrowserActionExtra>[0]["action"],
  args: Record<string, unknown>,
  targetId: string,
) {
  try {
    const cdpPort = ctx.state().cdpPort;
    await handleBrowserActionExtra({
      action,
      args,
      targetId,
      cdpPort,
      ctx,
      res,
    });
  } catch (err) {
    handleActionError(ctx, res, err);
  }
}

export function registerBrowserActionRoutes(
  app: express.Express,
  ctx: BrowserRouteContext,
) {
  app.post("/navigate", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runCoreAction(ctx, res, "navigate", body, targetId);
  });

  app.post("/back", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runCoreAction(ctx, res, "back", body, targetId);
  });

  app.post("/resize", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runCoreAction(ctx, res, "resize", body, targetId);
  });

  app.post("/close", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runCoreAction(ctx, res, "close", body, targetId);
  });

  app.post("/click", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runCoreAction(ctx, res, "click", body, targetId);
  });

  app.post("/type", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runCoreAction(ctx, res, "type", body, targetId);
  });

  app.post("/press", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runCoreAction(ctx, res, "press", body, targetId);
  });

  app.post("/hover", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runCoreAction(ctx, res, "hover", body, targetId);
  });

  app.post("/drag", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runCoreAction(ctx, res, "drag", body, targetId);
  });

  app.post("/select", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runCoreAction(ctx, res, "select", body, targetId);
  });

  app.post("/upload", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runCoreAction(ctx, res, "upload", body, targetId);
  });

  app.post("/fill", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runCoreAction(ctx, res, "fill", body, targetId);
  });

  app.post("/dialog", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runCoreAction(ctx, res, "dialog", body, targetId);
  });

  app.post("/wait", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runCoreAction(ctx, res, "wait", body, targetId);
  });

  app.post("/evaluate", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runCoreAction(ctx, res, "evaluate", body, targetId);
  });

  app.post("/run", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runCoreAction(ctx, res, "run", body, targetId);
  });

  app.get("/console", async (req, res) => {
    const targetId = readTargetId(req.query.targetId);
    const level = toStringOrEmpty(req.query.level);
    const args = level ? { level } : {};
    await runExtraAction(ctx, res, "console", args, targetId);
  });

  app.post("/pdf", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runExtraAction(ctx, res, "pdf", body, targetId);
  });

  app.post("/verify/element", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runExtraAction(ctx, res, "verifyElement", body, targetId);
  });

  app.post("/verify/text", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runExtraAction(ctx, res, "verifyText", body, targetId);
  });

  app.post("/verify/list", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runExtraAction(ctx, res, "verifyList", body, targetId);
  });

  app.post("/verify/value", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runExtraAction(ctx, res, "verifyValue", body, targetId);
  });

  app.post("/mouse/move", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runExtraAction(ctx, res, "mouseMove", body, targetId);
  });

  app.post("/mouse/click", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runExtraAction(ctx, res, "mouseClick", body, targetId);
  });

  app.post("/mouse/drag", async (req, res) => {
    const body = readBody(req);
    const targetId = readTargetId(body.targetId);
    await runExtraAction(ctx, res, "mouseDrag", body, targetId);
  });
}
