import { captureBaseline, listBaselines, saveBaseline } from "../baseline/capture.js";
import { getRuntimeConfig } from "../config/config.js";
import { redactConfigObject } from "../config/redact-snapshot.js";
import { createIncident, getOpenIncidents, readLedger } from "../incidents/ledger.js";
import { validatePluginContracts } from "../plugins/contract-validator.js";
import { executeWithCacheAndStagger, listCachedProbes } from "../probes/cache.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { tasksAuditJsonPayloadForDiagnose } from "./tasks-json.js";

export type DiagnoseOptions = {
  json?: boolean;
  timeoutMs?: number;
};

const DIAGNOSE_BASELINE_NAME = "diagnose-latest";
const DIAGNOSE_SCHEMA_VERSION = "openclaw-diagnose/v1";

function summarizeIncident(incident: {
  id: string;
  timestamp: string;
  type: string;
  severity: string;
  status: string;
  source: string;
}) {
  return {
    id: incident.id,
    timestamp: incident.timestamp,
    type: incident.type,
    severity: incident.severity,
    status: incident.status,
    source: incident.source,
  };
}

function summarizeGatewayConfig(gatewayConfig: Record<string, unknown>) {
  const { auth: _auth, ...safeGatewayConfig } = gatewayConfig;
  return safeGatewayConfig;
}

export async function buildDiagnoseJson(opts: DiagnoseOptions, _runtime: RuntimeEnv) {
  const cfg = getRuntimeConfig();
  const redactedGatewayConfig = redactConfigObject(cfg.gateway ?? {});
  const pluginContractsProbe = await executeWithCacheAndStagger(
    "plugin",
    "contracts",
    async () => validatePluginContracts({ config: cfg, strict: true }),
    {
      config: cfg,
      forceRefresh: true,
      baseDelayMs: 0,
      jitterMs: 0,
      ttlMs: opts.timeoutMs,
    },
  );
  const pluginContracts = pluginContractsProbe.result;
  const tasks = tasksAuditJsonPayloadForDiagnose({});
  const currentBaseline = await captureBaseline({
    config: cfg,
    skipGateway: opts.timeoutMs === 0,
    gatewayTimeoutMs: opts.timeoutMs,
  });
  await saveBaseline(currentBaseline, DIAGNOSE_BASELINE_NAME, cfg);
  if (!pluginContracts.ok || tasks.summary.combined.errors > 0) {
    const existing = getOpenIncidents(cfg).some(
      (incident) => incident.type === "gateway_health" && incident.source === "diagnose",
    );
    if (!existing) {
      createIncident(
        {
          type: "gateway_health",
          severity: pluginContracts.ok ? "medium" : "high",
          summary: "Control-plane diagnose detected failing checks",
          source: "diagnose",
          details: {
            pluginContractFindings: pluginContracts.findingCount,
            taskErrors: tasks.summary.combined.errors,
          },
        },
        cfg,
      );
    }
  }
  const ledger = readLedger(cfg);
  const openIncidents = getOpenIncidents(cfg);
  const baselines = listBaselines(cfg);
  const probeCache = listCachedProbes(cfg);
  return {
    schemaVersion: DIAGNOSE_SCHEMA_VERSION,
    ok: pluginContracts.ok && tasks.summary.combined.errors === 0 && openIncidents.length === 0,
    timestamp: new Date().toISOString(),
    redaction: {
      secretsIncluded: false,
      rawConfigIncluded: false,
      rawEnvIncluded: false,
    },
    persistence: {
      writesBaseline: true,
      writesProbeCache: true,
      writesIncidentLedger: true,
    },
    status: {
      gateway: summarizeGatewayConfig(redactedGatewayConfig),
      configuredChannels: Object.keys(cfg.channels ?? {}).length,
      configuredAgents: Object.keys(cfg.agents ?? {}).length,
    },
    plugins: {
      contracts: pluginContracts,
    },
    tasks,
    baselines: {
      count: baselines.length,
      latest: DIAGNOSE_BASELINE_NAME,
      current: {
        timestamp: currentBaseline.timestamp,
        components: currentBaseline.components,
        metrics: currentBaseline.metrics,
      },
      recent: baselines.slice(-10),
    },
    probeCache: {
      count: probeCache.length,
      stale: probeCache.filter((probe) => probe.stale).length,
      recent: probeCache.slice(-10),
    },
    incidents: {
      count: ledger.incidents.length,
      open: openIncidents.length,
      frozen: ledger.incidents.filter((incident) => incident.status === "frozen").length,
      repairs: ledger.repairs.length,
      recent: ledger.incidents.slice(-10).map(summarizeIncident),
    },
    actions: {
      safe: [
        "openclaw health --json",
        "openclaw gateway status --json",
        "openclaw tasks audit --json",
        "openclaw plugins contracts validate --strict --json",
      ],
      unsafe: [
        "openclaw doctor --fix",
        "openclaw gateway restart",
        "openclaw plugins update --all",
      ],
    },
  };
}

export async function diagnoseCommand(opts: DiagnoseOptions, runtime: RuntimeEnv) {
  const payload = await buildDiagnoseJson(opts, runtime);
  if (opts.json === true) {
    writeRuntimeJson(runtime, payload);
    return;
  }
  runtime.log(`Control-plane diagnosis: ${payload.ok ? "ok" : "attention needed"}`);
  runtime.log(`Open incidents: ${payload.incidents.open}`);
  runtime.log(`Plugin contract findings: ${payload.plugins.contracts.findingCount}`);
  runtime.log(`Task audit findings: ${payload.tasks.count}`);
}
