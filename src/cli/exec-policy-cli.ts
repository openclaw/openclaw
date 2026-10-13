// CLI for showing and applying exec policy presets across config and approvals.
import type { Command } from "commander";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { AgentSelectionRequiredError, listAgentIds } from "../agents/agent-scope-config.js";
import { readConfigFileSnapshot, replaceConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sanitizeExecApprovalDisplayText } from "../infra/exec-approval-text-sanitize.js";
import {
  collectExecPolicyScopeSnapshots,
  SESSION_EXEC_OVERRIDES_NOTE,
  type ExecPolicyScopeSnapshot,
} from "../infra/exec-approvals-effective.js";
import {
  normalizeExecAsk,
  normalizeExecMode,
  normalizeExecSecurity,
  normalizeExecTarget,
  readExecApprovalsSnapshotAsync,
  resolveExactExecModeFromPolicy,
  resolveExecModePolicy,
  restoreExecApprovalsSnapshotLocked,
  updateExecApprovals,
  type ExecApprovalsFile,
  type ExecAsk,
  type ExecSecurity,
  type ExecTarget,
} from "../infra/exec-approvals.js";
import { defaultRuntime } from "../runtime.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  buildExecPolicyToolAccess,
  formatExecPolicyCommandApprovals,
  renderExecPolicyToolAccess,
  type ExecPolicyToolAccess,
  type ExecPolicyShowOptions,
} from "./exec-policy-diagnostics.js";
import { ExpectedCliError, rethrowExpectedCliError } from "./failure-output.js";
import { addGatewayClientOptions, resolveGatewayRpcOptionsWithLocalPort } from "./gateway-rpc.js";
import { formatDocsHelp } from "./help-format.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";

type ExecPolicyPresetName = "yolo" | "cautious" | "deny-all";

type ExecPolicyResolved = {
  host?: ExecTarget;
  security?: ExecSecurity;
  ask?: ExecAsk;
  askFallback?: ExecSecurity;
};

const EXEC_POLICY_PRESETS: Record<ExecPolicyPresetName, Required<ExecPolicyResolved>> = {
  yolo: {
    host: "gateway",
    security: "full",
    ask: "off",
    askFallback: "full",
  },
  cautious: {
    host: "gateway",
    security: "allowlist",
    ask: "on-miss",
    askFallback: "deny",
  },
  "deny-all": {
    host: "gateway",
    security: "deny",
    ask: "off",
    askFallback: "deny",
  },
};

type ExecPolicyShowPayload = {
  toolAccess?: ExecPolicyToolAccess;
  toolAccessSelectionRequired?: { agentIds: string[]; hint: string };
  configPath: string;
  approvalsPath: string;
  approvalsExists: boolean;
  effectivePolicy: {
    note: string;
    scopes: ExecPolicyShowScope[];
  };
};

type ExecPolicyShowScope = ReturnType<typeof buildExecPolicyShowScope>;

function formatExecPolicyError(err: unknown): string {
  return sanitizeExecPolicyMessage(err instanceof Error ? err.message : String(err));
}

async function runExecPolicyAction(
  opts: { json?: boolean },
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    const message = formatExecPolicyError(err);
    // The root failure handler owns the JSON envelope; exiting here would leave stdout empty.
    if (opts.json) {
      rethrowExpectedCliError(err);
      const failure = new ExpectedCliError({
        message,
        humanOutput: message,
        machineOutput: message,
      });
      failure.cause = err;
      throw failure;
    }
    defaultRuntime.error(message);
    defaultRuntime.exit(1);
  }
}

function sanitizeExecPolicyTableCell(value: string): string {
  return sanitizeExecApprovalDisplayText(sanitizeTerminalText(value));
}

function sanitizeExecPolicyMessage(value: unknown): string {
  return sanitizeTerminalText(String(value));
}

function resolveExecPolicyInput(params: {
  host?: string;
  security?: string;
  ask?: string;
  askFallback?: string;
}): ExecPolicyResolved {
  const resolved: ExecPolicyResolved = {};
  const parse = <T extends string>(
    value: string,
    normalize: (value: string) => T | null,
    label: string,
  ): T => {
    const parsed = normalize(value);
    if (!parsed) {
      throw new Error(`Invalid exec ${label}: ${sanitizeExecPolicyMessage(value)}`);
    }
    return parsed;
  };
  if (params.host !== undefined) {
    resolved.host = parse(params.host, normalizeExecTarget, "host");
  }
  if (params.security !== undefined) {
    resolved.security = parse(params.security, normalizeExecSecurity, "security");
  }
  if (params.ask !== undefined) {
    resolved.ask = parse(params.ask, normalizeExecAsk, "ask mode");
  }
  if (params.askFallback !== undefined) {
    resolved.askFallback = parse(params.askFallback, normalizeExecSecurity, "askFallback");
  }
  return resolved;
}

function applyConfigExecPolicy(root: OpenClawConfig, policy: ExecPolicyResolved): void {
  root.tools ??= {};
  root.tools.exec ??= {};
  if (policy.host !== undefined) {
    root.tools.exec.host = policy.host;
  }
  if (policy.security !== undefined || policy.ask !== undefined) {
    const currentPolicy = resolveExecModePolicy({
      mode: normalizeExecMode(root.tools.exec.mode),
      security: root.tools.exec.security ?? "full",
      ask: root.tools.exec.ask ?? "off",
    });
    const security = policy.security ?? currentPolicy.security;
    const ask = policy.ask ?? currentPolicy.ask;
    const mode = resolveExactExecModeFromPolicy({ security, ask });
    if (mode) {
      root.tools.exec.mode = mode;
      delete root.tools.exec.security;
      delete root.tools.exec.ask;
    } else {
      delete root.tools.exec.mode;
      root.tools.exec.security = security;
      root.tools.exec.ask = ask;
    }
  }
}

function applyApprovalsDefaults(
  file: ExecApprovalsFile,
  policy: ExecPolicyResolved,
): ExecApprovalsFile {
  const next: ExecApprovalsFile = structuredClone(file ?? { version: 1 });
  next.version = 1;
  next.defaults ??= {};
  if (policy.security !== undefined) {
    next.defaults.security = policy.security;
  }
  if (policy.ask !== undefined) {
    next.defaults.ask = policy.ask;
  }
  if (policy.askFallback !== undefined) {
    next.defaults.askFallback = policy.askFallback;
  }
  return next;
}

async function buildLocalExecPolicyShowPayload(
  options?: ExecPolicyShowOptions,
): Promise<ExecPolicyShowPayload> {
  const configSnapshot = await readConfigFileSnapshot();
  const approvalsSnapshot = await readExecApprovalsSnapshotAsync();
  const config = configSnapshot.config ?? {};
  const scopes = collectExecPolicyScopeSnapshots({
    cfg: config,
    approvals: approvalsSnapshot.file,
    hostPath: approvalsSnapshot.path,
  }).map(buildExecPolicyShowScope);
  const hasNodeRuntimeScope = scopes.some(
    (scope) => scope.runtimeApprovalsSource === "node-runtime",
  );
  const baseNote = hasNodeRuntimeScope
    ? "Scopes requesting host=node are node-managed at runtime. Local approvals are shown only for local/gateway scopes."
    : "Effective exec policy is the host approvals policy intersected with requested tools.exec policy.";
  const payload: ExecPolicyShowPayload = {
    configPath: configSnapshot.path,
    approvalsPath: approvalsSnapshot.path,
    approvalsExists: approvalsSnapshot.exists,
    effectivePolicy: {
      note: `${baseNote} ${SESSION_EXEC_OVERRIDES_NOTE}`,
      scopes,
    },
  };
  if (!options) {
    return payload;
  }
  const hasExplicitTarget = options.agent !== undefined || options.session !== undefined;
  if (!hasExplicitTarget && listAgentIds(config).length === 0) {
    payload.toolAccessSelectionRequired = {
      agentIds: [],
      hint: "Configure an agent with openclaw agents add to inspect terminal tool access.",
    };
    return payload;
  }
  try {
    payload.toolAccess = await buildExecPolicyToolAccess(config, options);
  } catch (error) {
    if (hasExplicitTarget || !(error instanceof AgentSelectionRequiredError)) {
      throw error;
    }
    payload.toolAccessSelectionRequired = { agentIds: error.agentIds, hint: error.hint };
  }
  return payload;
}

function buildExecPolicyShowScope(snapshot: ExecPolicyScopeSnapshot) {
  const { allowedDecisions: _allowedDecisions, ...baseScope } = snapshot;
  if (snapshot.host.requested !== "node") {
    return {
      ...baseScope,
      runtimeApprovalsSource: "local-file" as const,
    };
  }
  const nodeManagedPolicy = (field: "security" | "ask") => ({
    requested: snapshot[field].requested,
    requestedSource: snapshot[field].requestedSource,
    host: "unknown" as const,
    hostSource: "node runtime approvals",
    effective: "unknown" as const,
    note: "runtime policy resolved by node approvals",
  });
  return {
    ...baseScope,
    runtimeApprovalsSource: "node-runtime" as const,
    security: nodeManagedPolicy("security"),
    ask: nodeManagedPolicy("ask"),
    askFallback: {
      effective: "unknown" as const,
      source: "node runtime approvals",
    },
  };
}

function renderExecPolicyShow(payload: ExecPolicyShowPayload): void {
  defaultRuntime.log(theme.heading("Exec Policy"));
  defaultRuntime.log(
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        { key: "Field", header: "Field", minWidth: 14 },
        { key: "Value", header: "Value", minWidth: 24, flex: true },
      ],
      rows: [
        { Field: "Config", Value: sanitizeExecPolicyTableCell(payload.configPath) },
        { Field: "Approvals", Value: sanitizeExecPolicyTableCell(payload.approvalsPath) },
        {
          Field: "Approvals State",
          Value: sanitizeExecPolicyTableCell(
            payload.approvalsExists ? "stored" : "defaults (no stored overrides)",
          ),
        },
      ],
    }).trimEnd(),
  );
  defaultRuntime.log("");
  defaultRuntime.log(theme.heading("Effective Policy"));
  defaultRuntime.log(
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        { key: "Scope", header: "Scope", minWidth: 12 },
        { key: "Requested", header: "Requested", minWidth: 24, flex: true },
        { key: "Host", header: "Host", minWidth: 24, flex: true },
        { key: "Effective", header: "Effective", minWidth: 16 },
      ],
      rows: payload.effectivePolicy.scopes.map((scope) => ({
        Scope: sanitizeExecPolicyTableCell(scope.scopeLabel),
        Requested: sanitizeExecPolicyTableCell(
          `host=${scope.host.requested} (${scope.host.requestedSource})\n` +
            `security=${scope.security.requested} (${scope.security.requestedSource})\n` +
            `ask=${scope.ask.requested} (${scope.ask.requestedSource})`,
        ),
        Host: sanitizeExecPolicyTableCell(
          `security=${scope.security.host} (${scope.security.hostSource})\n` +
            `ask=${scope.ask.host} (${scope.ask.hostSource})\n` +
            `askFallback=${scope.askFallback.effective} (${scope.askFallback.source})`,
        ),
        Effective: sanitizeExecPolicyTableCell(
          `security=${scope.security.effective}\nask=${scope.ask.effective}`,
        ),
      })),
    }).trimEnd(),
  );
  defaultRuntime.log("");
  defaultRuntime.log(theme.muted(payload.effectivePolicy.note));
}

function applyLocalExecPolicy(policy: ExecPolicyResolved): Promise<ExecPolicyShowPayload> {
  return runWithLocalStateOwner({
    method: "exec-policy.set",
    params: { ...policy },
    target: "local exec policy and approvals",
    onForeignOwner: "refuse",
    runLocal: ({ assertCurrent }) => applyOwnedExecPolicy(policy, assertCurrent),
  });
}

async function applyOwnedExecPolicy(
  policy: ExecPolicyResolved,
  assertCurrent: () => void,
): Promise<ExecPolicyShowPayload> {
  assertCurrent();
  const context = captureOpenClawStateWorkerContext();
  const configSnapshot = await readConfigFileSnapshot();
  assertCurrent();
  const nextConfig = structuredClone(configSnapshot.config ?? {});
  applyConfigExecPolicy(nextConfig, policy);
  if (nextConfig.tools?.exec?.host === "node") {
    throw new Error(
      "Local exec-policy cannot synchronize host=node. Node approvals are fetched from the node at runtime.",
    );
  }
  const approvalsSnapshot = await readExecApprovalsSnapshotAsync(context);
  assertCurrent();
  const nextApprovals = applyApprovalsDefaults(approvalsSnapshot.file, policy);
  const writtenApprovals = await updateExecApprovals(
    {
      baseHash: approvalsSnapshot.hash,
      assertCurrent,
      update: { kind: "replace", file: nextApprovals },
    },
    context,
  );
  if (!writtenApprovals) {
    throw new Error("Exec approvals changed; reload and retry.");
  }
  try {
    assertCurrent();
    await replaceConfigFile({
      baseHash: configSnapshot.hash,
      nextConfig,
      writeOptions: { assertCurrent },
    });
  } catch (err) {
    try {
      assertCurrent();
      if (
        !(await restoreExecApprovalsSnapshotLocked(
          approvalsSnapshot,
          writtenApprovals.hash,
          context,
          assertCurrent,
        ))
      ) {
        await updateExecApprovals(
          {
            assertCurrent,
            update: {
              kind: "rollback-defaults",
              original: approvalsSnapshot.file,
              written: writtenApprovals.file,
              policy,
            },
          },
          context,
        );
      }
    } catch (rollbackError) {
      throw new Error(
        `Config update failed: ${formatExecPolicyError(err)}; exec approvals rollback failed: ${formatExecPolicyError(rollbackError)}`,
        { cause: rollbackError },
      );
    }
    throw err;
  }
  return await buildLocalExecPolicyShowPayload();
}

export function registerExecPolicyCli(program: Command) {
  const execPolicy = program
    .command("exec-policy")
    .description("Show or synchronize requested exec policy with host approvals")
    .addHelpText("after", () => formatDocsHelp("/cli/approvals"));

  addGatewayClientOptions(
    execPolicy
      .command("show")
      .description("Explain terminal tool access and command approvals (offline unless --session)")
      .option("--agent <id>", "Agent whose terminal tools to inspect (automatic for one agent)")
      .option("--session <key>", "Fetch an existing session's tool preview from saved settings")
      .option("--verbose", "Include policy sources and all command approval scopes", false)
      .option("--json", "Output as JSON", false),
  ).action(async (opts: ExecPolicyShowOptions, command: Command) => {
    await runExecPolicyAction(opts, async () => {
      const payload = await buildLocalExecPolicyShowPayload(
        resolveGatewayRpcOptionsWithLocalPort(opts, command),
      );
      if (opts.json) {
        defaultRuntime.writeJson(payload, 0);
        return;
      }
      if (payload.toolAccess) {
        const scope =
          payload.effectivePolicy.scopes.find(
            (candidate) => candidate.scopeLabel === `agent:${payload.toolAccess?.agentId}`,
          ) ??
          payload.effectivePolicy.scopes.find(
            (candidate) => candidate.agentId === payload.toolAccess?.agentId,
          ) ??
          payload.effectivePolicy.scopes[0];
        renderExecPolicyToolAccess({
          access: payload.toolAccess,
          approvals: scope,
          approvalsExists: payload.approvalsExists,
          verbose: opts.verbose,
        });
      } else if (payload.toolAccessSelectionRequired) {
        const { agentIds, hint } = payload.toolAccessSelectionRequired;
        const title = `TERMINAL ACCESS — ${agentIds.length ? "SELECT AGENT" : "NO AGENT CONFIGURED"}`;
        defaultRuntime.log(theme.heading(title));
        if (agentIds.length > 0) {
          defaultRuntime.log(
            `Configured agents: ${agentIds.map(sanitizeExecPolicyTableCell).join(", ")}`,
          );
        }
        defaultRuntime.log("");
        const approvalsTitle = "── COMMAND APPROVALS (LOCAL) ──────────────────";
        defaultRuntime.log(theme.heading(approvalsTitle));
        defaultRuntime.log("");
        defaultRuntime.log(
          formatExecPolicyCommandApprovals({
            scopes: payload.effectivePolicy.scopes,
            approvalsExists: payload.approvalsExists,
            showScopeLabels: true,
          }).join("\n"),
        );
        defaultRuntime.log("");
        const nextStep = "── NEXT STEP ─────────────────────────────────";
        defaultRuntime.log(theme.heading(nextStep));
        defaultRuntime.log("");
        defaultRuntime.log(sanitizeExecPolicyTableCell(hint));
        if (!opts.verbose) {
          defaultRuntime.log(
            "Use --verbose for policy sources and detailed command approval scopes.",
          );
        }
      }
      if (opts.verbose) {
        defaultRuntime.log("");
        renderExecPolicyShow(payload);
      }
    });
  });

  execPolicy
    .command("preset <name>")
    .description('Apply a synchronized preset: "yolo", "cautious", or "deny-all"')
    .option("--json", "Output as JSON", false)
    .action(async (name: string, opts: { json?: boolean }) => {
      await runExecPolicyAction(opts, async () => {
        if (!Object.hasOwn(EXEC_POLICY_PRESETS, name)) {
          throw new Error(`Unknown exec-policy preset: ${sanitizeExecPolicyMessage(name)}`);
        }
        const preset = EXEC_POLICY_PRESETS[name as ExecPolicyPresetName];
        const payload = await applyLocalExecPolicy(preset);
        if (opts.json) {
          defaultRuntime.writeJson({ preset: name, ...payload }, 0);
          return;
        }
        defaultRuntime.log(`Applied exec-policy preset: ${sanitizeExecPolicyMessage(name)}`);
        defaultRuntime.log("");
        renderExecPolicyShow(payload);
      });
    });

  execPolicy
    .command("set")
    .description("Synchronize local config and host approvals using explicit values")
    .option("--host <host>", "Exec host target: auto|sandbox|gateway|node")
    .option("--security <mode>", "Exec security: deny|allowlist|full")
    .option("--ask <mode>", "Exec ask mode: off|on-miss|always")
    .option("--ask-fallback <mode>", "Host approvals fallback: deny|allowlist|full")
    .option("--json", "Output as JSON", false)
    .action(
      async (opts: {
        host?: string;
        security?: string;
        ask?: string;
        askFallback?: string;
        json?: boolean;
      }) => {
        await runExecPolicyAction(opts, async () => {
          const policy = resolveExecPolicyInput(opts);
          if (Object.keys(policy).length === 0) {
            throw new Error(
              "Provide at least one of --host, --security, --ask, or --ask-fallback.",
            );
          }
          const payload = await applyLocalExecPolicy(policy);
          if (opts.json) {
            defaultRuntime.writeJson({ applied: policy, ...payload }, 0);
            return;
          }
          defaultRuntime.log("Synchronized local exec policy.");
          defaultRuntime.log("");
          renderExecPolicyShow(payload);
        });
      },
    );
}
