import fs from "node:fs/promises";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import JSON5 from "json5";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { readBestEffortConfig, type OpenClawConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  collectExecPolicyScopeSnapshots,
  type ExecPolicyScopeSnapshot,
} from "../infra/exec-approvals-effective.js";
import {
  normalizeExecApprovals,
  readExecApprovalsSnapshot,
  saveExecApprovals,
  type ExecApprovalsAgent,
  type ExecApprovalsFile,
} from "../infra/exec-approvals.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import { defaultRuntime } from "../runtime.js";
import { callGatewayFromCli } from "./gateway-rpc.js";
import { nodesCallOpts, resolveNodeId } from "./nodes-cli/rpc.js";
import type { NodesRpcOpts } from "./nodes-cli/types.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

type ExecApprovalsSnapshot = {
  path?: string;
  exists?: boolean;
  hash?: string;
  baseHash?: string;
  file?: ExecApprovalsFile;
  enabled?: boolean;
  defaultAction?: string;
  rules?: NativeExecApprovalRule[];
  constraints?: Record<string, unknown>;
};

type ConfigSnapshotLike = {
  config?: OpenClawConfig;
};
type NativeExecApprovalRule = {
  pattern?: string;
  action?: string;
  shells?: string[];
  description?: string;
  enabled?: boolean;
};
type NativeExecApprovalPolicy = {
  enabled?: boolean;
  defaultAction?: string;
  rules?: NativeExecApprovalRule[];
};
type ConfigLoadResult = {
  config: OpenClawConfig | null;
  timedOut: boolean;
};
type ApprovalsTargetSource = "gateway" | "node" | "local";
type EffectivePolicyReport = {
  scopes: ExecPolicyScopeSnapshot[];
  note?: string;
};
const APPROVALS_GET_DEFAULT_TIMEOUT_MS = 60_000;

type ExecApprovalsCliOpts = NodesRpcOpts & {
  node?: string;
  gateway?: boolean;
  file?: string;
  stdin?: boolean;
  agent?: string;
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveTargetNodeId(opts: ExecApprovalsCliOpts): Promise<string | null> {
  if (opts.gateway) {
    return null;
  }
  const raw = normalizeOptionalString(opts.node) ?? "";
  if (!raw) {
    return null;
  }
  return await resolveNodeId(opts as NodesRpcOpts, raw);
}

async function loadSnapshot(
  opts: ExecApprovalsCliOpts,
  nodeId: string | null,
): Promise<ExecApprovalsSnapshot> {
  const method = nodeId ? "exec.approvals.node.get" : "exec.approvals.get";
  const params = nodeId ? { nodeId } : {};
  const snapshot = (await callGatewayFromCli(method, opts, params)) as ExecApprovalsSnapshot;
  return snapshot;
}

function loadSnapshotLocal(): ExecApprovalsSnapshot {
  const snapshot = readExecApprovalsSnapshot();
  return {
    path: snapshot.path,
    exists: snapshot.exists,
    hash: snapshot.hash,
    file: snapshot.file,
  };
}

function hasApprovalsFile(
  snapshot: ExecApprovalsSnapshot,
): snapshot is ExecApprovalsSnapshot & { file: ExecApprovalsFile } {
  return (
    Boolean(snapshot.file) && typeof snapshot.file === "object" && !Array.isArray(snapshot.file)
  );
}

function isNativeExecApprovalsSnapshot(snapshot: ExecApprovalsSnapshot): boolean {
  return (
    Array.isArray(snapshot.rules) ||
    typeof snapshot.defaultAction === "string" ||
    typeof snapshot.enabled === "boolean"
  );
}

function normalizeNativeExecApprovalPolicyInput(value: unknown): NativeExecApprovalPolicy {
  if (!isRecord(value)) {
    exitWithError("Host-native exec approvals JSON must be an object.");
  }
  if ("version" in value || "defaults" in value || "agents" in value) {
    exitWithError(
      "Host-native node approvals require JSON with defaultAction and rules, not exec-approvals.json file syntax.",
    );
  }
  const defaultAction = normalizeOptionalString(value["defaultAction"]) ?? undefined;
  const rulesRaw = value["rules"];
  if (rulesRaw !== undefined && !Array.isArray(rulesRaw)) {
    exitWithError("Host-native exec approvals rules must be an array.");
  }
  const rules = Array.isArray(rulesRaw)
    ? rulesRaw.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          exitWithError("Host-native exec approval rules must be objects.");
        }
        if (!isRecord(entry)) {
          exitWithError("Host-native exec approval rules must be objects.");
        }
        const pattern = normalizeOptionalString(entry["pattern"]);
        const action = normalizeOptionalString(entry["action"]);
        if (!pattern || !action) {
          exitWithError("Host-native exec approval rules require pattern and action.");
        }
        const shellsRaw = entry["shells"];
        if (shellsRaw !== undefined && !Array.isArray(shellsRaw)) {
          exitWithError("Host-native exec approval rule shells must be an array.");
        }
        const shells = Array.isArray(shellsRaw)
          ? shellsRaw.map((shell) => String(shell)).filter((shell) => shell.trim().length > 0)
          : undefined;
        const nextRule: NativeExecApprovalRule = {
          pattern,
          action,
        };
        if (shells && shells.length > 0) {
          nextRule.shells = shells;
        }
        if (typeof entry["description"] === "string") {
          nextRule.description = entry["description"];
        }
        if (typeof entry["enabled"] === "boolean") {
          nextRule.enabled = entry["enabled"];
        }
        return nextRule;
      })
    : undefined;
  const hasRulesField = Array.isArray(rulesRaw);
  const hasNonEmptyRules = Boolean(rules && rules.length > 0);
  if (!defaultAction && !hasNonEmptyRules) {
    exitWithError("Host-native exec approvals JSON must include defaultAction or rules.");
  }
  return {
    ...(typeof value["enabled"] === "boolean" ? { enabled: value["enabled"] } : {}),
    ...(defaultAction ? { defaultAction } : {}),
    ...(hasRulesField ? { rules: rules ?? [] } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: string | null): value is string {
  return value !== null;
}

function saveSnapshotLocal(file: ExecApprovalsFile): ExecApprovalsSnapshot {
  saveExecApprovals(file);
  return loadSnapshotLocal();
}

async function loadSnapshotTarget(opts: ExecApprovalsCliOpts): Promise<{
  snapshot: ExecApprovalsSnapshot;
  nodeId: string | null;
  source: ApprovalsTargetSource;
}> {
  if (!opts.gateway && !opts.node) {
    return { snapshot: loadSnapshotLocal(), nodeId: null, source: "local" };
  }
  const nodeId = await resolveTargetNodeId(opts);
  const snapshot = await loadSnapshot(opts, nodeId);
  return { snapshot, nodeId, source: nodeId ? "node" : "gateway" };
}

function exitWithError(message: string): never {
  defaultRuntime.error(message);
  defaultRuntime.exit(1);
  throw new Error(message);
}

function requireTrimmedNonEmpty(value: string, message: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    exitWithError(message);
  }
  return trimmed;
}

async function loadWritableSnapshotTarget(opts: ExecApprovalsCliOpts): Promise<{
  snapshot: ExecApprovalsSnapshot;
  nodeId: string | null;
  source: ApprovalsTargetSource;
  targetLabel: string;
  baseHash: string;
  nativePolicy: boolean;
}> {
  const { snapshot, nodeId, source } = await loadSnapshotTarget(opts);
  if (source === "local") {
    defaultRuntime.log(theme.muted("Writing local approvals."));
  }
  const targetLabel = source === "local" ? "local" : nodeId ? `node:${nodeId}` : "gateway";
  const baseHash = snapshot.hash ?? snapshot.baseHash;
  if (!baseHash) {
    exitWithError("Exec approvals hash missing; reload and retry.");
  }
  if (!hasApprovalsFile(snapshot)) {
    if (source === "node" && isNativeExecApprovalsSnapshot(snapshot)) {
      return { snapshot, nodeId, source, targetLabel, baseHash, nativePolicy: true };
    }
    exitWithError(
      "This node exposes a host-native exec policy. Editing it through approvals set/allowlist is not supported yet.",
    );
  }
  return { snapshot, nodeId, source, targetLabel, baseHash, nativePolicy: false };
}

async function saveSnapshotTargeted(params: {
  opts: ExecApprovalsCliOpts;
  source: ApprovalsTargetSource;
  nodeId: string | null;
  file?: ExecApprovalsFile;
  native?: NativeExecApprovalPolicy;
  baseHash: string;
  targetLabel: string;
}): Promise<void> {
  let next: ExecApprovalsSnapshot;
  if (params.source === "local") {
    next = saveSnapshotLocal(params.file ?? { version: 1 });
  } else if (params.native) {
    await saveSnapshotNative(params.opts, params.nodeId, params.native, params.baseHash);
    next = await loadSnapshot(params.opts, params.nodeId);
  } else {
    next = await saveSnapshot(
      params.opts,
      params.nodeId,
      params.file ?? { version: 1 },
      params.baseHash,
    );
  }
  if (params.opts.json) {
    defaultRuntime.writeJson(next, 0);
    return;
  }
  defaultRuntime.log(theme.muted(`Target: ${params.targetLabel}`));
  renderApprovalsSnapshot(next, params.targetLabel);
}

function formatCliError(err: unknown): string {
  const msg = formatErrorMessage(err);
  const firstLine = msg.includes("\n") ? msg.split("\n")[0] : msg;
  const safe = sanitizeForLog(firstLine);
  return safe.length > 300 ? `${safe.slice(0, 300)}...` : safe;
}

async function loadConfigForApprovalsTarget(params: {
  opts: ExecApprovalsCliOpts;
  source: ApprovalsTargetSource;
}): Promise<ConfigLoadResult> {
  try {
    if (params.source === "local") {
      return { config: await readBestEffortConfig(), timedOut: false };
    }
    const snapshot = (await callGatewayFromCli(
      "config.get",
      params.opts,
      {},
    )) as ConfigSnapshotLike;
    return {
      config: snapshot.config && typeof snapshot.config === "object" ? snapshot.config : null,
      timedOut: false,
    };
  } catch (err) {
    return {
      config: null,
      timedOut: /^gateway timeout after \d+ms\b/i.test(formatCliError(err)),
    };
  }
}

function buildEffectivePolicyReport(params: {
  configLoad: ConfigLoadResult;
  source: ApprovalsTargetSource;
  approvals?: ExecApprovalsFile;
  hostPath: string;
  nativePolicy: boolean;
}): EffectivePolicyReport {
  const cfg = params.configLoad.config;
  const timeoutNote = params.configLoad.timedOut
    ? "Config fetch timed out. Re-run with a higher --timeout to inspect Effective Policy."
    : null;
  if (!params.approvals) {
    return {
      scopes: [],
      note: params.nativePolicy
        ? "Node exposes a host-native exec policy. The node enforces its own rules; local approvals-file effective-policy math does not apply."
        : "Approvals file unavailable.",
    };
  }
  if (params.source === "node") {
    if (!cfg) {
      return {
        scopes: [],
        note:
          timeoutNote ??
          "Gateway config unavailable. Node output above shows host approvals state only, and final runtime policy still intersects with gateway tools.exec.",
      };
    }
    return {
      scopes: collectExecPolicyScopeSnapshots({
        cfg,
        approvals: params.approvals,
        hostPath: params.hostPath,
      }),
      note: "Effective exec policy is the node host approvals file intersected with gateway tools.exec policy.",
    };
  }
  if (!cfg) {
    return {
      scopes: [],
      note: timeoutNote ?? "Config unavailable.",
    };
  }
  return {
    scopes: collectExecPolicyScopeSnapshots({
      cfg,
      approvals: params.approvals,
      hostPath: params.hostPath,
    }),
    note: "Effective exec policy is the host approvals file intersected with requested tools.exec policy.",
  };
}

function renderEffectivePolicy(params: { report: EffectivePolicyReport }) {
  const rich = isRich();
  const heading = (text: string) => (rich ? theme.heading(text) : text);
  const muted = (text: string) => (rich ? theme.muted(text) : text);
  if (params.report.scopes.length === 0 && !params.report.note) {
    return;
  }
  defaultRuntime.log("");
  defaultRuntime.log(heading("Effective Policy"));
  if (params.report.scopes.length === 0) {
    defaultRuntime.log(muted(params.report.note ?? "No effective policy details available."));
    return;
  }
  const rows = params.report.scopes.map((summary) => ({
    Scope: summary.scopeLabel,
    Requested: `security=${summary.security.requested} (${summary.security.requestedSource})\nask=${summary.ask.requested} (${summary.ask.requestedSource})`,
    Host: `security=${summary.security.host} (${summary.security.hostSource})\nask=${summary.ask.host} (${summary.ask.hostSource})\naskFallback=${summary.askFallback.effective} (${summary.askFallback.source})`,
    Effective: `security=${summary.security.effective}\nask=${summary.ask.effective}`,
    Notes: `${summary.security.note}; ${summary.ask.note}`,
  }));
  defaultRuntime.log(
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        { key: "Scope", header: "Scope", minWidth: 12 },
        { key: "Requested", header: "Requested", minWidth: 24, flex: true },
        { key: "Host", header: "Host", minWidth: 24, flex: true },
        { key: "Effective", header: "Effective", minWidth: 16 },
        { key: "Notes", header: "Notes", minWidth: 20, flex: true },
      ],
      rows,
    }).trimEnd(),
  );
  defaultRuntime.log("");
  defaultRuntime.log(muted(`Precedence: ${params.report.note}`));
}

function renderApprovalsSnapshot(snapshot: ExecApprovalsSnapshot, targetLabel: string) {
  if (!hasApprovalsFile(snapshot) && isNativeExecApprovalsSnapshot(snapshot)) {
    renderNativeExecPolicySnapshot(snapshot, targetLabel);
    return;
  }
  const rich = isRich();
  const heading = (text: string) => (rich ? theme.heading(text) : text);
  const muted = (text: string) => (rich ? theme.muted(text) : text);
  const tableWidth = getTerminalTableWidth();

  const file = snapshot.file ?? { version: 1 };
  const defaults = file.defaults ?? {};
  const defaultsParts = [
    defaults.security ? `security=${defaults.security}` : null,
    defaults.ask ? `ask=${defaults.ask}` : null,
    defaults.askFallback ? `askFallback=${defaults.askFallback}` : null,
    typeof defaults.autoAllowSkills === "boolean"
      ? `autoAllowSkills=${defaults.autoAllowSkills ? "on" : "off"}`
      : null,
  ].filter(isString);
  const agents = file.agents ?? {};
  const allowlistRows: Array<{ Target: string; Agent: string; Pattern: string; LastUsed: string }> =
    [];
  const now = Date.now();
  for (const [agentId, agent] of Object.entries(agents)) {
    const allowlist = Array.isArray(agent.allowlist) ? agent.allowlist : [];
    for (const entry of allowlist) {
      const pattern = normalizeOptionalString(entry?.pattern) ?? "";
      if (!pattern) {
        continue;
      }
      const lastUsedAt = typeof entry.lastUsedAt === "number" ? entry.lastUsedAt : null;
      allowlistRows.push({
        Target: targetLabel,
        Agent: agentId,
        Pattern: pattern,
        LastUsed: lastUsedAt ? formatTimeAgo(Math.max(0, now - lastUsedAt)) : muted("unknown"),
      });
    }
  }

  const summaryRows = [
    { Field: "Target", Value: targetLabel },
    { Field: "Path", Value: snapshot.path ?? "unknown" },
    { Field: "Exists", Value: snapshot.exists ? "yes" : "no" },
    { Field: "Hash", Value: snapshot.hash ?? "unknown" },
    { Field: "Version", Value: String(file.version ?? 1) },
    { Field: "Socket", Value: file.socket?.path ?? "default" },
    { Field: "Defaults", Value: defaultsParts.length > 0 ? defaultsParts.join(", ") : "none" },
    { Field: "Agents", Value: String(Object.keys(agents).length) },
    { Field: "Allowlist", Value: String(allowlistRows.length) },
  ];

  defaultRuntime.log(heading("Approvals"));
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Field", header: "Field", minWidth: 8 },
        { key: "Value", header: "Value", minWidth: 24, flex: true },
      ],
      rows: summaryRows,
    }).trimEnd(),
  );

  if (allowlistRows.length === 0) {
    defaultRuntime.log("");
    defaultRuntime.log(muted("No allowlist entries."));
    return;
  }

  defaultRuntime.log("");
  defaultRuntime.log(heading("Allowlist"));
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Target", header: "Target", minWidth: 10 },
        { key: "Agent", header: "Agent", minWidth: 8 },
        { key: "Pattern", header: "Pattern", minWidth: 20, flex: true },
        { key: "LastUsed", header: "Last Used", minWidth: 10 },
      ],
      rows: allowlistRows,
    }).trimEnd(),
  );
}

async function saveSnapshot(
  opts: ExecApprovalsCliOpts,
  nodeId: string | null,
  file: ExecApprovalsFile,
  baseHash: string,
): Promise<ExecApprovalsSnapshot> {
  const method = nodeId ? "exec.approvals.node.set" : "exec.approvals.set";
  const params = nodeId ? { nodeId, file, baseHash } : { file, baseHash };
  const snapshot = (await callGatewayFromCli(method, opts, params)) as ExecApprovalsSnapshot;
  return snapshot;
}

async function saveSnapshotNative(
  opts: ExecApprovalsCliOpts,
  nodeId: string | null,
  native: NativeExecApprovalPolicy,
  baseHash: string,
): Promise<void> {
  if (!nodeId) {
    exitWithError("Host-native exec approvals can only target a node.");
  }
  await callGatewayFromCli("exec.approvals.node.set", opts, { nodeId, native, baseHash });
}

function resolveAgentKey(value?: string | null): string {
  const trimmed = normalizeOptionalString(value) ?? "";
  return trimmed ? trimmed : "*";
}

function normalizeAllowlistEntry(entry: { pattern?: string } | null): string | null {
  const pattern = normalizeOptionalString(entry?.pattern) ?? "";
  return pattern ? pattern : null;
}

function ensureAgent(file: ExecApprovalsFile, agentKey: string): ExecApprovalsAgent {
  const agents = file.agents ?? {};
  const entry = agents[agentKey] ?? {};
  file.agents = agents;
  return entry;
}

function isEmptyAgent(agent: ExecApprovalsAgent): boolean {
  const allowlist = Array.isArray(agent.allowlist) ? agent.allowlist : [];
  return (
    !agent.security &&
    !agent.ask &&
    !agent.askFallback &&
    agent.autoAllowSkills === undefined &&
    allowlist.length === 0
  );
}

async function loadWritableAllowlistAgent(opts: ExecApprovalsCliOpts): Promise<{
  nodeId: string | null;
  source: "gateway" | "node" | "local";
  targetLabel: string;
  baseHash: string;
  file: ExecApprovalsFile;
  agentKey: string;
  agent: ExecApprovalsAgent;
  allowlistEntries: NonNullable<ExecApprovalsAgent["allowlist"]>;
}> {
  const { snapshot, nodeId, source, targetLabel, baseHash, nativePolicy } =
    await loadWritableSnapshotTarget(opts);
  if (nativePolicy) {
    exitWithError(
      "Host-native node approvals do not support allowlist mutations. Use approvals set --node with host-native JSON.",
    );
  }
  const file = snapshot.file ?? { version: 1 };
  file.version = 1;

  const agentKey = resolveAgentKey(opts.agent);
  const agent = ensureAgent(file, agentKey);
  const allowlistEntries = Array.isArray(agent.allowlist) ? agent.allowlist : [];

  return { nodeId, source, targetLabel, baseHash, file, agentKey, agent, allowlistEntries };
}

type WritableAllowlistAgentContext = Awaited<ReturnType<typeof loadWritableAllowlistAgent>> & {
  trimmedPattern: string;
};
type AllowlistMutation = (context: WritableAllowlistAgentContext) => boolean | Promise<boolean>;

async function runAllowlistMutation(
  pattern: string,
  opts: ExecApprovalsCliOpts,
  mutate: AllowlistMutation,
): Promise<void> {
  try {
    const trimmedPattern = requireTrimmedNonEmpty(pattern, "Pattern required.");
    const context = await loadWritableAllowlistAgent(opts);
    const shouldSave = await mutate({ ...context, trimmedPattern });
    if (!shouldSave) {
      return;
    }
    await saveSnapshotTargeted({
      opts,
      source: context.source,
      nodeId: context.nodeId,
      file: context.file,
      baseHash: context.baseHash,
      targetLabel: context.targetLabel,
    });
  } catch (err) {
    defaultRuntime.error(formatCliError(err));
    defaultRuntime.exit(1);
  }
}

function renderNativeExecPolicySnapshot(snapshot: ExecApprovalsSnapshot, targetLabel: string) {
  const rich = isRich();
  const heading = (text: string) => (rich ? theme.heading(text) : text);
  const muted = (text: string) => (rich ? theme.muted(text) : text);
  const tableWidth = getTerminalTableWidth();
  const rules = Array.isArray(snapshot.rules) ? snapshot.rules : [];
  const summaryRows = [
    { Field: "Target", Value: targetLabel },
    { Field: "Kind", Value: "host-native" },
    {
      Field: "Enabled",
      Value: typeof snapshot.enabled === "boolean" ? (snapshot.enabled ? "yes" : "no") : "unknown",
    },
    { Field: "Default Action", Value: snapshot.defaultAction ?? "unknown" },
    { Field: "Hash", Value: snapshot.hash ?? snapshot.baseHash ?? "unknown" },
    { Field: "Rules", Value: String(rules.length) },
  ];

  defaultRuntime.log(heading("Approvals"));
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Field", header: "Field", minWidth: 8 },
        { key: "Value", header: "Value", minWidth: 24, flex: true },
      ],
      rows: summaryRows,
    }).trimEnd(),
  );

  if (rules.length === 0) {
    defaultRuntime.log("");
    defaultRuntime.log(muted("No host-native rules."));
    return;
  }

  defaultRuntime.log("");
  defaultRuntime.log(heading("Host Rules"));
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Pattern", header: "Pattern", minWidth: 20, flex: true },
        { key: "Action", header: "Action", minWidth: 8 },
        { key: "Shells", header: "Shells", minWidth: 12 },
        { key: "Enabled", header: "Enabled", minWidth: 8 },
        { key: "Description", header: "Description", minWidth: 16, flex: true },
      ],
      rows: rules.map((rule) => ({
        Pattern: rule.pattern ?? "",
        Action: rule.action ?? "",
        Shells:
          Array.isArray(rule.shells) && rule.shells.length > 0 ? rule.shells.join(",") : "all",
        Enabled: rule.enabled === false ? "no" : "yes",
        Description: rule.description ?? "",
      })),
    }).trimEnd(),
  );
}

function registerAllowlistMutationCommand(params: {
  allowlist: Command;
  name: "add" | "remove";
  description: string;
  mutate: AllowlistMutation;
}): Command {
  const command = params.allowlist
    .command(`${params.name} <pattern>`)
    .description(params.description)
    .option("--node <node>", "Target node id/name/IP")
    .option("--gateway", "Force gateway approvals", false)
    .option("--agent <id>", 'Agent id (defaults to "*")')
    .action(async (pattern: string, opts: ExecApprovalsCliOpts) => {
      await runAllowlistMutation(pattern, opts, params.mutate);
    });
  nodesCallOpts(command);
  return command;
}

export function registerExecApprovalsCli(program: Command) {
  const formatExample = (cmd: string, desc: string) =>
    `  ${theme.command(cmd)}\n    ${theme.muted(desc)}`;

  const approvals = program
    .command("approvals")
    .alias("exec-approvals")
    .description("Manage exec approvals (gateway or node host)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/approvals", "docs.openclaw.ai/cli/approvals")}\n`,
    );

  const getCmd = approvals
    .command("get")
    .description("Fetch exec approvals snapshot")
    .option("--node <node>", "Target node id/name/IP")
    .option("--gateway", "Force gateway approvals", false)
    .action(async (opts: ExecApprovalsCliOpts) => {
      try {
        const { snapshot, nodeId, source } = await loadSnapshotTarget(opts);
        const configLoad = await loadConfigForApprovalsTarget({ opts, source });
        const effectivePolicy = buildEffectivePolicyReport({
          configLoad,
          source,
          approvals: snapshot.file,
          hostPath: snapshot.path ?? "node host policy",
          nativePolicy: isNativeExecApprovalsSnapshot(snapshot),
        });
        if (opts.json) {
          defaultRuntime.writeJson({ ...snapshot, effectivePolicy }, 0);
          return;
        }

        const muted = (text: string) => (isRich() ? theme.muted(text) : text);
        if (source === "local") {
          defaultRuntime.log(muted("Showing local approvals."));
          defaultRuntime.log("");
        }
        const targetLabel = source === "local" ? "local" : nodeId ? `node:${nodeId}` : "gateway";
        renderApprovalsSnapshot(snapshot, targetLabel);
        renderEffectivePolicy({ report: effectivePolicy });
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
  nodesCallOpts(getCmd, { timeoutMs: APPROVALS_GET_DEFAULT_TIMEOUT_MS });

  const setCmd = approvals
    .command("set")
    .description("Replace exec approvals with a JSON file")
    .option("--node <node>", "Target node id/name/IP")
    .option("--gateway", "Force gateway approvals", false)
    .option("--file <path>", "Path to JSON file to upload")
    .option("--stdin", "Read JSON from stdin", false)
    .action(async (opts: ExecApprovalsCliOpts) => {
      try {
        if (!opts.file && !opts.stdin) {
          exitWithError("Provide --file or --stdin.");
        }
        if (opts.file && opts.stdin) {
          exitWithError("Use either --file or --stdin (not both).");
        }
        const { source, nodeId, targetLabel, baseHash, nativePolicy } =
          await loadWritableSnapshotTarget(opts);
        const raw = opts.stdin ? await readStdin() : await fs.readFile(String(opts.file), "utf8");
        let parsed: unknown;
        try {
          parsed = JSON5.parse(raw);
        } catch (err) {
          exitWithError(`Failed to parse approvals JSON: ${String(err)}`);
        }
        if (nativePolicy) {
          const native = normalizeNativeExecApprovalPolicyInput(parsed);
          await saveSnapshotTargeted({ opts, source, nodeId, native, baseHash, targetLabel });
          return;
        }
        const file = normalizeExecApprovals(parsed as ExecApprovalsFile);
        file.version = 1;
        await saveSnapshotTargeted({ opts, source, nodeId, file, baseHash, targetLabel });
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
  nodesCallOpts(setCmd);

  const allowlist = approvals
    .command("allowlist")
    .description("Edit the per-agent allowlist")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatExample(
          'openclaw approvals allowlist add "~/Projects/**/bin/rg"',
          "Allowlist a local binary pattern for the main agent.",
        )}\n${formatExample(
          'openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"',
          "Allowlist on a specific node/agent.",
        )}\n${formatExample(
          'openclaw approvals allowlist add --agent "*" "/usr/bin/uname"',
          "Allowlist for all agents (wildcard).",
        )}\n${formatExample(
          'openclaw approvals allowlist remove "~/Projects/**/bin/rg"',
          "Remove an allowlist pattern.",
        )}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/approvals", "docs.openclaw.ai/cli/approvals")}\n`,
    );

  registerAllowlistMutationCommand({
    allowlist,
    name: "add",
    description: "Add a glob pattern to an allowlist",
    mutate: ({ trimmedPattern, file, agent, agentKey, allowlistEntries }) => {
      if (allowlistEntries.some((entry) => normalizeAllowlistEntry(entry) === trimmedPattern)) {
        defaultRuntime.log("Already allowlisted.");
        return false;
      }
      allowlistEntries.push({ pattern: trimmedPattern, lastUsedAt: Date.now() });
      agent.allowlist = allowlistEntries;
      file.agents = { ...file.agents, [agentKey]: agent };
      return true;
    },
  });

  registerAllowlistMutationCommand({
    allowlist,
    name: "remove",
    description: "Remove a glob pattern from an allowlist",
    mutate: ({ trimmedPattern, file, agent, agentKey, allowlistEntries }) => {
      const nextEntries = allowlistEntries.filter(
        (entry) => normalizeAllowlistEntry(entry) !== trimmedPattern,
      );
      if (nextEntries.length === allowlistEntries.length) {
        defaultRuntime.log("Pattern not found.");
        return false;
      }
      if (nextEntries.length === 0) {
        delete agent.allowlist;
      } else {
        agent.allowlist = nextEntries;
      }
      if (isEmptyAgent(agent)) {
        const agents = { ...file.agents };
        delete agents[agentKey];
        file.agents = Object.keys(agents).length > 0 ? agents : undefined;
      } else {
        file.agents = { ...file.agents, [agentKey]: agent };
      }
      return true;
    },
  });

  applyParentDefaultHelpAction(approvals);
}
