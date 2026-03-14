import { access, constants } from "node:fs/promises";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";

type PreflightCheckResult = {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
};

/**
 * Run lightweight preflight checks after onboarding completes.
 * Each check reuses existing subsystem code and has a 3-second timeout.
 * Results are printed but never block setup completion.
 */
export async function runPostOnboardPreflight(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  opts?: { isRemote?: boolean },
): Promise<void> {
  const checks: Promise<PreflightCheckResult>[] = [checkConfig()];

  if (!opts?.isRemote) {
    checks.push(checkGateway(cfg));
    checks.push(checkWorkspace(cfg));
  }

  checks.push(checkAuth(cfg));
  checks.push(checkModel(cfg));

  const results = await Promise.allSettled(checks);
  const resolved: PreflightCheckResult[] = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { name: `check-${i}`, status: "fail" as const, detail: String(r.reason) },
  );

  const warnCount = resolved.filter((r) => r.status === "warn").length;
  const failCount = resolved.filter((r) => r.status === "fail").length;
  const issueCount = warnCount + failCount;

  const lines = ["", "Preflight checks:"];
  for (const r of resolved) {
    const icon = r.status === "pass" ? "PASS" : r.status === "warn" ? "WARN" : "FAIL";
    lines.push(`  [${icon}] ${r.name} (${r.detail})`);
  }

  if (issueCount > 0) {
    const { formatCliCommand } = await import("../cli/command-format.js");
    lines.push(
      "",
      `${issueCount} issue${issueCount > 1 ? "s" : ""} found. Run ${formatCliCommand("openclaw doctor")} for detailed diagnostics.`,
    );
  }

  runtime.log(lines.join("\n"));
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

const TIMEOUT_MS = 3_000;

async function checkConfig(): Promise<PreflightCheckResult> {
  return withTimeout(
    (async (): Promise<PreflightCheckResult> => {
      const { readConfigFileSnapshot } = await import("../config/io.js");
      const snapshot = await readConfigFileSnapshot();

      if (!snapshot.exists) {
        return { name: "Config", status: "fail", detail: "openclaw.json not found" };
      }
      if (!snapshot.valid) {
        const firstIssue = snapshot.issues?.[0];
        const detail = firstIssue ? (firstIssue.message ?? "validation error") : "invalid config";
        return { name: "Config", status: "fail", detail };
      }
      return { name: "Config", status: "pass", detail: "openclaw.json valid" };
    })(),
    TIMEOUT_MS,
    { name: "Config", status: "warn", detail: "check timed out" },
  );
}

async function checkGateway(cfg: OpenClawConfig): Promise<PreflightCheckResult> {
  return withTimeout(
    (async (): Promise<PreflightCheckResult> => {
      const { probeGatewayReachable, resolveControlUiLinks } = await import("./onboard-helpers.js");

      const port = cfg.gateway?.port ?? 18789;
      const bind = cfg.gateway?.bind ?? "loopback";
      const links = resolveControlUiLinks({
        bind: bind as "auto" | "lan" | "loopback" | "custom" | "tailnet",
        port,
        customBindHost: cfg.gateway?.customBindHost,
        basePath: undefined,
      });

      const probe = await probeGatewayReachable({
        url: links.wsUrl,
        timeoutMs: 2_500,
      });

      return probe.ok
        ? { name: "Gateway", status: "pass", detail: `reachable at port ${port}` }
        : {
            name: "Gateway",
            status: "warn",
            detail: probe.detail ?? "not reachable",
          };
    })(),
    TIMEOUT_MS,
    { name: "Gateway", status: "warn", detail: "check timed out" },
  );
}

async function checkAuth(cfg: OpenClawConfig): Promise<PreflightCheckResult> {
  return withTimeout(
    (async (): Promise<PreflightCheckResult> => {
      const { buildAuthHealthSummary } = await import("../agents/auth-health.js");
      const { loadAuthProfileStore } = await import("../agents/auth-profiles/store.js");

      let store;
      try {
        store = loadAuthProfileStore();
      } catch {
        // No auth store is valid (e.g. --auth-choice skip).
        return { name: "Auth", status: "pass", detail: "no auth profiles configured" };
      }

      const summary = buildAuthHealthSummary({ store, cfg });

      if (summary.providers.length === 0) {
        return { name: "Auth", status: "pass", detail: "no providers configured" };
      }

      const expired = summary.providers.filter((p) => p.status === "expired");
      const missing = summary.providers.filter((p) => p.status === "missing");

      if (expired.length > 0) {
        return {
          name: "Auth",
          status: "warn",
          detail: `${expired[0].provider} token expired`,
        };
      }
      if (missing.length > 0) {
        return {
          name: "Auth",
          status: "warn",
          detail: `${missing[0].provider} credentials missing`,
        };
      }
      return { name: "Auth", status: "pass", detail: "credentials valid" };
    })(),
    TIMEOUT_MS,
    { name: "Auth", status: "warn", detail: "check timed out" },
  );
}

async function checkWorkspace(cfg: OpenClawConfig): Promise<PreflightCheckResult> {
  return withTimeout(
    (async (): Promise<PreflightCheckResult> => {
      const workspaceDir = cfg.agents?.defaults?.workspace ?? "~/.openclaw/workspace";
      const { resolveUserPath } = await import("../utils.js");
      const resolved = resolveUserPath(workspaceDir);

      try {
        await access(resolved, constants.W_OK);
        return { name: "Workspace", status: "pass", detail: "writable" };
      } catch {
        return {
          name: "Workspace",
          status: "warn",
          detail: `${workspaceDir} not writable`,
        };
      }
    })(),
    TIMEOUT_MS,
    { name: "Workspace", status: "warn", detail: "check timed out" },
  );
}

async function checkModel(cfg: OpenClawConfig): Promise<PreflightCheckResult> {
  return withTimeout(
    (async (): Promise<PreflightCheckResult> => {
      const { loadModelCatalog } = await import("../agents/model-catalog.js");
      const { resolveConfiguredModelRef, getModelRefStatus } =
        await import("../agents/model-selection.js");
      const { DEFAULT_MODEL, DEFAULT_PROVIDER } = await import("../agents/defaults.js");

      const catalog = await loadModelCatalog({ config: cfg });
      const ref = resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const status = getModelRefStatus({
        cfg,
        catalog,
        ref,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });

      if (status.inCatalog || status.allowAny) {
        return {
          name: "Model",
          status: "pass",
          detail: `${ref.provider}/${ref.model}`,
        };
      }
      return {
        name: "Model",
        status: "warn",
        detail: `${ref.provider}/${ref.model} not in catalog`,
      };
    })(),
    TIMEOUT_MS,
    { name: "Model", status: "warn", detail: "check timed out" },
  );
}
