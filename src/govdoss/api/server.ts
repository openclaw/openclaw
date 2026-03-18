import express from "express";
import { authenticateGovdossApiKey } from "./auth.js";
import {
  handleApproveRoute,
  handleExecuteRoute,
  handleRejectRoute,
  handleResumeRoute,
  handleUsageRoute,
} from "./routes.js";
import { createTenantContext } from "../tenant-context.js";

export function createGovdossApiServer() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true, service: "govdoss-api" });
  });

  app.use((req, res, next) => {
    const tenantId = String(req.header("x-govdoss-tenant-id") || "default-tenant");
    const workspaceId = req.header("x-govdoss-workspace-id") || undefined;
    const apiKey = req.header("x-api-key") || req.header("authorization")?.replace(/^Bearer\s+/i, "") || null;

    const tenant = createTenantContext({
      tenantId,
      workspaceId,
      planTier: (req.header("x-govdoss-plan-tier") as any) || "team",
      complianceModes: (req.header("x-govdoss-compliance-modes") || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
      billingAccountId: req.header("x-govdoss-billing-account") || undefined,
    });

    const auth = authenticateGovdossApiKey({ apiKey, tenant });
    if (!auth.ok || !auth.principal || !auth.tenant) {
      res.status(401).json({ ok: false, error: auth.reason || "unauthorized" });
      return;
    }

    (req as any).govdoss = {
      principal: auth.principal,
      tenant: auth.tenant,
    };
    next();
  });

  app.post("/execute", async (req, res) => {
    const { principal } = (req as any).govdoss;
    const body = (req.body || {}) as { method?: string; params?: Record<string, unknown> };
    if (!body.method) {
      res.status(400).json({ ok: false, error: "method is required" });
      return;
    }
    const result = await handleExecuteRoute({ principal, method: body.method, params: body.params });
    res.status(202).json({ ok: true, result });
  });

  app.post("/approvals/:approvalId/approve", (req, res) => {
    const { principal } = (req as any).govdoss;
    const result = handleApproveRoute({ principal, approvalId: req.params.approvalId });
    res.status(200).json({ ok: true, result });
  });

  app.post("/approvals/:approvalId/reject", (req, res) => {
    const { principal } = (req as any).govdoss;
    const result = handleRejectRoute({ principal, approvalId: req.params.approvalId });
    res.status(200).json({ ok: true, result });
  });

  app.post("/approvals/:approvalId/resume", async (req, res) => {
    const { principal } = (req as any).govdoss;
    const result = await handleResumeRoute({ principal, approvalId: req.params.approvalId });
    res.status(200).json({ ok: true, result });
  });

  app.get("/usage", (req, res) => {
    const { principal } = (req as any).govdoss;
    const result = handleUsageRoute({ principal });
    res.status(200).json({ ok: true, result });
  });

  return app;
}

export function startGovdossApiServer(port = Number(process.env.GOVDOSS_API_PORT || 8787)) {
  const app = createGovdossApiServer();
  return app.listen(port, () => {
    console.log(`[govdoss-api] listening on :${port}`);
  });
}
