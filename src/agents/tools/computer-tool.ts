import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { saveMediaBuffer } from "../../media/store.js";
import { sanitizeToolResultImages } from "../tool-images.js";
import { stringEnum } from "../schema/typebox.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";
import { imageResultFromFile, jsonResult, type AnyAgentTool, readStringParam } from "./common.js";

const COMPUTER_TOOL_ACTIONS = [
  "snapshot",
  "wait",
  "release",
  "reset_focus",
  "hover",
  "find",
  "click_text",
  "click_text_uia",
  "focus_text",
  "set_value_text",
  "move",
  "click",
  "dblclick",
  "right_click",
  "mouse_down",
  "mouse_up",
  "mouse_hold",
  "scroll",
  "type",
  "key_down",
  "key_up",
  "key_hold",
  "hotkey",
  "press",
  "drag",
  "teach_start",
  "teach_finish",
  "teach_rename",
] as const;

type ComputerToolAction = (typeof COMPUTER_TOOL_ACTIONS)[number];

type TeachStep = {
  id: string;
  atMs: number;
  action: string;
  params: Record<string, unknown>;
};

type TeachState = {
  version: 1;
  startedAtMs: number;
  steps: TeachStep[];
  skillDir?: string;
};

const ComputerToolSchema = Type.Object({
  action: stringEnum(COMPUTER_TOOL_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),

  // approvals
  confirm: Type.Optional(stringEnum(["always", "dangerous", "off"] as const)),

  // snapshot
  overlay: Type.Optional(stringEnum(["none", "grid", "dual"] as const)),

  // wait / hover
  durationMs: Type.Optional(Type.Number()),
  // reset_focus
  escCount: Type.Optional(Type.Number()),

  // UI automation text search
  text: Type.Optional(Type.String()),
  match: Type.Optional(stringEnum(["contains", "exact", "prefix"] as const)),
  caseSensitive: Type.Optional(Type.Boolean()),
  controlType: Type.Optional(Type.String()),
  maxResults: Type.Optional(Type.Number()),
  resultIndex: Type.Optional(Type.Number()),
  focusMode: Type.Optional(stringEnum(["mouse", "uia", "auto"] as const)),
  value: Type.Optional(Type.String()),
  valueFallback: Type.Optional(Type.Boolean()),
  invokeFallback: Type.Optional(Type.Boolean()),

  // Common action params
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  x2: Type.Optional(Type.Number()),
  y2: Type.Optional(Type.Number()),
  button: Type.Optional(stringEnum(["left", "right", "middle"] as const)),
  clicks: Type.Optional(Type.Number()),
  delayMs: Type.Optional(Type.Number()),
  steps: Type.Optional(Type.Number()),
  stepDelayMs: Type.Optional(Type.Number()),
  jitterPx: Type.Optional(Type.Number()),

  // scroll
  deltaY: Type.Optional(Type.Number()),

  // type/hotkey/press
  key: Type.Optional(Type.String()),
  ctrl: Type.Optional(Type.Boolean()),
  alt: Type.Optional(Type.Boolean()),
  shift: Type.Optional(Type.Boolean()),
  meta: Type.Optional(Type.Boolean()),

  // teach
  name: Type.Optional(Type.String()),
});

function encodePowerShell(script: string): string {
  // -EncodedCommand expects UTF-16LE.
  return Buffer.from(script, "utf16le").toString("base64");
}

async function runPowerShell(params: {
  script: string;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(1, Math.floor(params.timeoutMs))
      : 30_000;

  const encoded = encodePowerShell(params.script);

  return await new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
      ],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

async function runPowerShellJson<T>(params: {
  script: string;
  timeoutMs?: number;
}): Promise<T> {
  const res = await runPowerShell(params);
  if (res.exitCode !== 0) {
    const message = res.stderr.trim() || res.stdout.trim() || `powershell exit ${res.exitCode}`;
    throw new Error(message);
  }
  const raw = res.stdout.trim();
  if (!raw) {
    throw new Error("powershell returned empty output");
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`powershell did not return JSON: ${String(err)}\n${raw.slice(0, 2000)}`, {
      cause: err,
    });
  }
}

function requireNumber(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`${key} required`);
}

function readPositiveInt(params: Record<string, unknown>, key: string, fallback: number) {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.floor(parsed));
    }
  }
  return Math.max(1, Math.floor(fallback));
}

function readNonNegativeInt(params: Record<string, unknown>, key: string, fallback: number) {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed));
    }
  }
  return Math.max(0, Math.floor(fallback));
}

const KEY_TOKEN_SPECIAL: Record<string, string> = {
  enter: "{ENTER}",
  return: "{ENTER}",
  tab: "{TAB}",
  esc: "{ESC}",
  escape: "{ESC}",
  backspace: "{BACKSPACE}",
  bs: "{BACKSPACE}",
  del: "{DELETE}",
  delete: "{DELETE}",
  insert: "{INSERT}",
  ins: "{INSERT}",
  home: "{HOME}",
  end: "{END}",
  pgup: "{PGUP}",
  pageup: "{PGUP}",
  pgdn: "{PGDN}",
  pagedown: "{PGDN}",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  space: "{SPACE}",
  shift: "{SHIFT}",
  ctrl: "{CTRL}",
  control: "{CTRL}",
  alt: "{ALT}",
};

function normalizeKeyToken(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("key required");
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  const special = KEY_TOKEN_SPECIAL[lower];
  if (special) {
    return special;
  }
  const fnMatch = /^f(\d{1,2})$/i.exec(trimmed);
  if (fnMatch?.[1]) {
    const n = Number.parseInt(fnMatch[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= 24) {
      return `{F${n}}`;
    }
  }
  if (trimmed.length === 1) {
    return trimmed;
  }
  // Last resort: pass token to the Windows key resolver (advanced syntax like {TAB 3}).
  return trimmed;
}

function resolveTeachStatePath(agentDir: string, sessionKey: string) {
  return path.join(agentDir, "computer-teach", `${sessionKey}.json`);
}

async function loadTeachState(params: {
  agentDir: string;
  sessionKey: string;
}): Promise<TeachState | null> {
  const filePath = resolveTeachStatePath(params.agentDir, params.sessionKey);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as TeachState;
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
      return null;
    }
    if (!Array.isArray(parsed.steps)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function saveTeachState(params: {
  agentDir: string;
  sessionKey: string;
  state: TeachState;
}): Promise<void> {
  const filePath = resolveTeachStatePath(params.agentDir, params.sessionKey);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(params.state, null, 2), "utf-8");
}

function sanitizeSkillName(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return base.slice(0, 64) || "computer-skill";
}

function autoSkillName(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").replace("Z", "");
  return sanitizeSkillName(`computer-use-${ts}-${crypto.randomUUID().slice(0, 8)}`);
}

async function ensureApproval(params: {
  gatewayOpts: GatewayCallOptions;
  command: string;
  timeoutMs?: number;
  allowAlwaysCache: Set<string>;
}): Promise<void> {
  const key = crypto.createHash("sha256").update(params.command, "utf8").digest("hex");
  if (params.allowAlwaysCache.has(key)) {
    return;
  }

  const res = await callGatewayTool<{ decision?: string }>(
    "exec.approval.request",
    params.gatewayOpts,
    {
      id: crypto.randomUUID(),
      command: params.command,
      host: "computer",
      ask: "always",
      timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : 120_000,
    },
    { expectFinal: true },
  );
  const decision = res && typeof res === "object" ? (res as { decision?: string }).decision : null;
  if (decision === "deny") {
    throw new Error("computer action denied by user");
  }
  if (decision === "allow-always") {
    params.allowAlwaysCache.add(key);
    return;
  }
  if (decision !== "allow-once") {
    throw new Error("computer action approval missing");
  }
}

type ComputerConfirmMode = "always" | "dangerous" | "off";

type UiHitTestResult = {
  name?: string;
  controlType?: string;
  automationId?: string;
  className?: string;
  frameworkId?: string;
  helpText?: string;
};

type UiTextMatch = UiHitTestResult & {
  x?: number;
  y?: number;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

const DEFAULT_DANGER_TOKENS = [
  "ok",
  "yes",
  "confirm",
  "submit",
  "send",
  "buy",
  "purchase",
  "pay",
  "order",
  "checkout",
  "delete",
  "remove",
  "uninstall",
  "format",
  "apply",
] as const;

function compileDangerMatchers(tokens: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const token of tokens) {
    const raw = token.trim();
    if (!raw) {
      continue;
    }
    const safe = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out.push(new RegExp(`(^|[^a-z0-9])${safe}([^a-z0-9]|$)`, "i"));
  }
  return out;
}

const DEFAULT_UI_HIT_MATCHERS = compileDangerMatchers(DEFAULT_DANGER_TOKENS);

function matchesDangerToken(text: string, matchers: RegExp[]): boolean {
  const raw = text.trim();
  if (!raw) {
    return false;
  }
  return matchers.some((re) => re.test(raw));
}

function isDangerousUiHit(hit: UiHitTestResult, matchers: RegExp[]): boolean {
  const textFields = [hit.name, hit.helpText, hit.automationId].filter(
    (v): v is string => typeof v === "string",
  );
  if (textFields.some((v) => matchesDangerToken(v, matchers))) {
    return true;
  }
  return false;
}

async function resolveUiHitTest(params: { x: number; y: number }): Promise<UiHitTestResult | null> {
  const script = `
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$x = ${"${"}x}
$y = ${"${"}y}
$pt = New-Object System.Windows.Point $x, $y

$el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)

function Elem-ToObj($e) {
  if (-not $e) { return $null }
  $current = $e.Current
  $ct = $null
  try { $ct = $current.ControlType.ProgrammaticName } catch { $ct = $null }
  return @{ 
    name = $current.Name
    automationId = $current.AutomationId
    className = $current.ClassName
    frameworkId = $current.FrameworkId
    helpText = $current.HelpText
    controlType = $ct
  }
}

$obj = Elem-ToObj $el
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

for ($i = 0; $i -lt 4; $i++) {
  if (-not $obj) { break }
  $name = [string]$obj.name
  if ($name -and $name.Trim().Length -gt 0) { break }
  $el = $walker.GetParent($el)
  $obj = Elem-ToObj $el
}

if (-not $obj) {
  @{ ok = $false } | ConvertTo-Json -Compress | Write-Output
} else {
  $obj.ok = $true
  $obj | ConvertTo-Json -Compress | Write-Output
}
`;

  const res = await runPowerShellJson<Record<string, unknown>>({
    script: script.replace("${" + "x}", String(params.x)).replace("${" + "y}", String(params.y)),
    timeoutMs: 5_000,
  });

  if (!res || typeof res !== "object" || res.ok !== true) {
    return null;
  }
  return {
    name: typeof res.name === "string" ? res.name : undefined,
    controlType: typeof res.controlType === "string" ? res.controlType : undefined,
    automationId: typeof res.automationId === "string" ? res.automationId : undefined,
    className: typeof res.className === "string" ? res.className : undefined,
    frameworkId: typeof res.frameworkId === "string" ? res.frameworkId : undefined,
    helpText: typeof res.helpText === "string" ? res.helpText : undefined,
  };
}

async function resolveUiTextMatches(params: {
  text: string;
  match?: "contains" | "exact" | "prefix";
  caseSensitive?: boolean;
  controlType?: string;
  maxResults?: number;
}): Promise<UiTextMatch[]> {
  const payload = Buffer.from(JSON.stringify(params), "utf-8").toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

function Get-Args() {
  $raw = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))
  return ($raw | ConvertFrom-Json)
}

$args = Get-Args
$text = [string]$args.text
if (-not $text) { throw 'text required' }

$mode = 'contains'
if ($args.PSObject.Properties.Name -contains 'match') { $mode = [string]$args.match }

$caseSensitive = $false
if ($args.PSObject.Properties.Name -contains 'caseSensitive') { $caseSensitive = [bool]$args.caseSensitive }

$controlType = $null
if ($args.PSObject.Properties.Name -contains 'controlType') { $controlType = [string]$args.controlType }

$maxResults = 5
if ($args.PSObject.Properties.Name -contains 'maxResults') { $maxResults = [int]$args.maxResults }
if ($maxResults -lt 1) { $maxResults = 1 }
if ($maxResults -gt 25) { $maxResults = 25 }

$needle = $text
if (-not $caseSensitive) { $needle = $needle.ToLowerInvariant() }

function Matches([string]$value) {
  if (-not $value) { return $false }
  $v = $value
  if (-not $caseSensitive) { $v = $v.ToLowerInvariant() }
  switch ($mode) {
    'exact' { return $v -eq $needle }
    'prefix' { return $v.StartsWith($needle) }
    default { return $v.Contains($needle) }
  }
}

function Match-ControlType([string]$ct) {
  if (-not $controlType) { return $true }
  if (-not $ct) { return $false }
  $wanted = $controlType.ToLowerInvariant()
  if ($wanted.StartsWith('controltype.')) { $wanted = $wanted.Substring(12) }
  $ctLower = $ct.ToLowerInvariant()
  return $ctLower.EndsWith($wanted)
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition)
$results = @()

foreach ($el in $all) {
  $current = $el.Current
  $ct = $null
  try { $ct = $current.ControlType.ProgrammaticName } catch { $ct = $null }
  if (-not (Match-ControlType $ct)) { continue }

  $name = $current.Name
  $automationId = $current.AutomationId
  $helpText = $current.HelpText
  if (-not (Matches $name) -and -not (Matches $automationId) -and -not (Matches $helpText)) { continue }

  $rect = $current.BoundingRectangle
  $width = [double]$rect.Width
  $height = [double]$rect.Height

  $x = $null
  $y = $null
  if ($width -gt 1 -and $height -gt 1) {
    $x = [int][Math]::Round($rect.X + ($width / 2.0))
    $y = [int][Math]::Round($rect.Y + ($height / 2.0))
  }

  $results += @{ 
    name = $name
    automationId = $automationId
    helpText = $helpText
    controlType = $ct
    x = $x
    y = $y
    bounds = @{ x = $rect.X; y = $rect.Y; width = $width; height = $height }
  }
  if ($results.Count -ge $maxResults) { break }
}

$results | ConvertTo-Json -Compress | Write-Output
`;

  const res = await runPowerShellJson<unknown>({ script, timeoutMs: 10_000 });
  if (!Array.isArray(res)) {
    return [];
  }
  const matches: UiTextMatch[] = [];
  for (const entry of res) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const rec = entry as Record<string, unknown>;
    const boundsRec = rec.bounds && typeof rec.bounds === "object" ? (rec.bounds as Record<string, unknown>) : null;
    matches.push({
      name: typeof rec.name === "string" ? rec.name : undefined,
      automationId: typeof rec.automationId === "string" ? rec.automationId : undefined,
      helpText: typeof rec.helpText === "string" ? rec.helpText : undefined,
      controlType: typeof rec.controlType === "string" ? rec.controlType : undefined,
      x: typeof rec.x === "number" && Number.isFinite(rec.x) ? rec.x : undefined,
      y: typeof rec.y === "number" && Number.isFinite(rec.y) ? rec.y : undefined,
      bounds:
        boundsRec && typeof boundsRec.x === "number" && typeof boundsRec.y === "number"
          ? {
              x: Number(boundsRec.x),
              y: Number(boundsRec.y),
              width: typeof boundsRec.width === "number" ? Number(boundsRec.width) : 0,
              height: typeof boundsRec.height === "number" ? Number(boundsRec.height) : 0,
            }
          : undefined,
    });
  }
  return matches;
}

async function tryFocusUiElement(params: {
  text: string;
  match: "contains" | "exact" | "prefix";
  caseSensitive: boolean;
  controlType?: string;
  maxResults: number;
  resultIndex: number;
}): Promise<{ success: boolean; target?: UiTextMatch }> {
  const payload = Buffer.from(JSON.stringify(params), "utf-8").toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

function Get-Args() {
  $raw = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))
  return ($raw | ConvertFrom-Json)
}

$args = Get-Args
$text = [string]$args.text
if (-not $text) { throw 'text required' }

$mode = [string]$args.match
$caseSensitive = [bool]$args.caseSensitive
$controlType = $args.controlType
$maxResults = [int]$args.maxResults
$index = [int]$args.resultIndex

$needle = $text
if (-not $caseSensitive) { $needle = $needle.ToLowerInvariant() }

function Matches([string]$value) {
  if (-not $value) { return $false }
  $v = $value
  if (-not $caseSensitive) { $v = $v.ToLowerInvariant() }
  switch ($mode) {
    'exact' { return $v -eq $needle }
    'prefix' { return $v.StartsWith($needle) }
    default { return $v.Contains($needle) }
  }
}

function Match-ControlType([string]$ct) {
  if (-not $controlType) { return $true }
  if (-not $ct) { return $false }
  $wanted = $controlType.ToLowerInvariant()
  if ($wanted.StartsWith('controltype.')) { $wanted = $wanted.Substring(12) }
  $ctLower = $ct.ToLowerInvariant()
  return $ctLower.EndsWith($wanted)
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition)
$results = @()

foreach ($el in $all) {
  $current = $el.Current
  $ct = $null
  try { $ct = $current.ControlType.ProgrammaticName } catch { $ct = $null }
  if (-not (Match-ControlType $ct)) { continue }

  $name = $current.Name
  $automationId = $current.AutomationId
  $helpText = $current.HelpText
  if (-not (Matches $name) -and -not (Matches $automationId) -and -not (Matches $helpText)) { continue }

  $results += $el
  if ($results.Count -ge $maxResults) { break }
}

if ($results.Count -eq 0) {
  @{ ok = $false; reason = 'not-found' } | ConvertTo-Json -Compress | Write-Output
  exit
}

if ($index -ge $results.Count) {
  @{ ok = $false; reason = 'index' } | ConvertTo-Json -Compress | Write-Output
  exit
}

$target = $results[$index]
$rect = $target.Current.BoundingRectangle
$width = [double]$rect.Width
$height = [double]$rect.Height
$x = $null
$y = $null
if ($width -gt 1 -and $height -gt 1) {
  $x = [int][Math]::Round($rect.X + ($width / 2.0))
  $y = [int][Math]::Round($rect.Y + ($height / 2.0))
}

$focused = $false
try {
  $target.SetFocus()
  $focused = $true
} catch {
  $focused = $false
}

@{
  ok = $focused
  name = $target.Current.Name
  automationId = $target.Current.AutomationId
  helpText = $target.Current.HelpText
  controlType = $target.Current.ControlType.ProgrammaticName
  x = $x
  y = $y
} | ConvertTo-Json -Compress | Write-Output
`;

  const res = await runPowerShellJson<Record<string, unknown>>({ script, timeoutMs: 10_000 });
  if (!res || typeof res !== "object" || res.ok !== true) {
    return { success: false };
  }
  return {
    success: true,
    target: {
      name: typeof res.name === "string" ? res.name : undefined,
      automationId: typeof res.automationId === "string" ? res.automationId : undefined,
      helpText: typeof res.helpText === "string" ? res.helpText : undefined,
      controlType: typeof res.controlType === "string" ? res.controlType : undefined,
      x: typeof res.x === "number" && Number.isFinite(res.x) ? res.x : undefined,
      y: typeof res.y === "number" && Number.isFinite(res.y) ? res.y : undefined,
    },
  };
}

async function trySetValueUiElement(params: {
  text: string;
  value: string;
  match: "contains" | "exact" | "prefix";
  caseSensitive: boolean;
  controlType?: string;
  maxResults: number;
  resultIndex: number;
}): Promise<{ success: boolean; target?: UiTextMatch; reason?: string }> {
  const payload = Buffer.from(JSON.stringify(params), "utf-8").toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

function Get-Args() {
  $raw = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))
  return ($raw | ConvertFrom-Json)
}

$args = Get-Args
$text = [string]$args.text
if (-not $text) { throw 'text required' }
$value = [string]$args.value

$mode = [string]$args.match
$caseSensitive = [bool]$args.caseSensitive
$controlType = $args.controlType
$maxResults = [int]$args.maxResults
$index = [int]$args.resultIndex

$needle = $text
if (-not $caseSensitive) { $needle = $needle.ToLowerInvariant() }

function Matches([string]$value) {
  if (-not $value) { return $false }
  $v = $value
  if (-not $caseSensitive) { $v = $v.ToLowerInvariant() }
  switch ($mode) {
    'exact' { return $v -eq $needle }
    'prefix' { return $v.StartsWith($needle) }
    default { return $v.Contains($needle) }
  }
}

function Match-ControlType([string]$ct) {
  if (-not $controlType) { return $true }
  if (-not $ct) { return $false }
  $wanted = $controlType.ToLowerInvariant()
  if ($wanted.StartsWith('controltype.')) { $wanted = $wanted.Substring(12) }
  $ctLower = $ct.ToLowerInvariant()
  return $ctLower.EndsWith($wanted)
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition)
$results = @()

foreach ($el in $all) {
  $current = $el.Current
  $ct = $null
  try { $ct = $current.ControlType.ProgrammaticName } catch { $ct = $null }
  if (-not (Match-ControlType $ct)) { continue }

  $name = $current.Name
  $automationId = $current.AutomationId
  $helpText = $current.HelpText
  if (-not (Matches $name) -and -not (Matches $automationId) -and -not (Matches $helpText)) { continue }

  $results += $el
  if ($results.Count -ge $maxResults) { break }
}

if ($results.Count -eq 0) {
  @{ ok = $false; reason = 'not-found' } | ConvertTo-Json -Compress | Write-Output
  exit
}

if ($index -ge $results.Count) {
  @{ ok = $false; reason = 'index' } | ConvertTo-Json -Compress | Write-Output
  exit
}

$target = $results[$index]
$rect = $target.Current.BoundingRectangle
$width = [double]$rect.Width
$height = [double]$rect.Height
$x = $null
$y = $null
if ($width -gt 1 -and $height -gt 1) {
  $x = [int][Math]::Round($rect.X + ($width / 2.0))
  $y = [int][Math]::Round($rect.Y + ($height / 2.0))
}

try {
  $pattern = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
} catch {
  @{ ok = $false; reason = 'value-pattern' } | ConvertTo-Json -Compress | Write-Output
  exit
}

try {
  $pattern.SetValue($value)
} catch {
  @{ ok = $false; reason = 'set-value' } | ConvertTo-Json -Compress | Write-Output
  exit
}

@{
  ok = $true
  name = $target.Current.Name
  automationId = $target.Current.AutomationId
  helpText = $target.Current.HelpText
  controlType = $target.Current.ControlType.ProgrammaticName
  x = $x
  y = $y
} | ConvertTo-Json -Compress | Write-Output
`;

  const res = await runPowerShellJson<Record<string, unknown>>({ script, timeoutMs: 10_000 });
  if (!res || typeof res !== "object" || res.ok !== true) {
    return { success: false, reason: typeof res?.reason === "string" ? res.reason : undefined };
  }
  return {
    success: true,
    target: {
      name: typeof res.name === "string" ? res.name : undefined,
      automationId: typeof res.automationId === "string" ? res.automationId : undefined,
      helpText: typeof res.helpText === "string" ? res.helpText : undefined,
      controlType: typeof res.controlType === "string" ? res.controlType : undefined,
      x: typeof res.x === "number" && Number.isFinite(res.x) ? res.x : undefined,
      y: typeof res.y === "number" && Number.isFinite(res.y) ? res.y : undefined,
    },
  };
}

async function tryInvokeUiElement(params: {
  text: string;
  match: "contains" | "exact" | "prefix";
  caseSensitive: boolean;
  controlType?: string;
  maxResults: number;
  resultIndex: number;
}): Promise<{ success: boolean; target?: UiTextMatch; reason?: string }> {
  const payload = Buffer.from(JSON.stringify(params), "utf-8").toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

function Get-Args() {
  $raw = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))
  return ($raw | ConvertFrom-Json)
}

$args = Get-Args
$text = [string]$args.text
if (-not $text) { throw 'text required' }

$mode = [string]$args.match
$caseSensitive = [bool]$args.caseSensitive
$controlType = $args.controlType
$maxResults = [int]$args.maxResults
$index = [int]$args.resultIndex

$needle = $text
if (-not $caseSensitive) { $needle = $needle.ToLowerInvariant() }

function Matches([string]$value) {
  if (-not $value) { return $false }
  $v = $value
  if (-not $caseSensitive) { $v = $v.ToLowerInvariant() }
  switch ($mode) {
    'exact' { return $v -eq $needle }
    'prefix' { return $v.StartsWith($needle) }
    default { return $v.Contains($needle) }
  }
}

function Match-ControlType([string]$ct) {
  if (-not $controlType) { return $true }
  if (-not $ct) { return $false }
  $wanted = $controlType.ToLowerInvariant()
  if ($wanted.StartsWith('controltype.')) { $wanted = $wanted.Substring(12) }
  $ctLower = $ct.ToLowerInvariant()
  return $ctLower.EndsWith($wanted)
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition)
$results = @()

foreach ($el in $all) {
  $current = $el.Current
  $ct = $null
  try { $ct = $current.ControlType.ProgrammaticName } catch { $ct = $null }
  if (-not (Match-ControlType $ct)) { continue }

  $name = $current.Name
  $automationId = $current.AutomationId
  $helpText = $current.HelpText
  if (-not (Matches $name) -and -not (Matches $automationId) -and -not (Matches $helpText)) { continue }

  $results += $el
  if ($results.Count -ge $maxResults) { break }
}

if ($results.Count -eq 0) {
  @{ ok = $false; reason = 'not-found' } | ConvertTo-Json -Compress | Write-Output
  exit
}

if ($index -ge $results.Count) {
  @{ ok = $false; reason = 'index' } | ConvertTo-Json -Compress | Write-Output
  exit
}

$target = $results[$index]
$rect = $target.Current.BoundingRectangle
$width = [double]$rect.Width
$height = [double]$rect.Height
$x = $null
$y = $null
if ($width -gt 1 -and $height -gt 1) {
  $x = [int][Math]::Round($rect.X + ($width / 2.0))
  $y = [int][Math]::Round($rect.Y + ($height / 2.0))
}

try {
  $pattern = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
} catch {
  @{ ok = $false; reason = 'invoke-pattern' } | ConvertTo-Json -Compress | Write-Output
  exit
}

try {
  $pattern.Invoke()
} catch {
  @{ ok = $false; reason = 'invoke' } | ConvertTo-Json -Compress | Write-Output
  exit
}

@{
  ok = $true
  name = $target.Current.Name
  automationId = $target.Current.AutomationId
  helpText = $target.Current.HelpText
  controlType = $target.Current.ControlType.ProgrammaticName
  x = $x
  y = $y
} | ConvertTo-Json -Compress | Write-Output
`;

  const res = await runPowerShellJson<Record<string, unknown>>({ script, timeoutMs: 10_000 });
  if (!res || typeof res !== "object" || res.ok !== true) {
    return { success: false, reason: typeof res?.reason === "string" ? res.reason : undefined };
  }
  return {
    success: true,
    target: {
      name: typeof res.name === "string" ? res.name : undefined,
      automationId: typeof res.automationId === "string" ? res.automationId : undefined,
      helpText: typeof res.helpText === "string" ? res.helpText : undefined,
      controlType: typeof res.controlType === "string" ? res.controlType : undefined,
      x: typeof res.x === "number" && Number.isFinite(res.x) ? res.x : undefined,
      y: typeof res.y === "number" && Number.isFinite(res.y) ? res.y : undefined,
    },
  };
}

function isDangerousAction(action: ComputerToolAction, params: Record<string, unknown>): boolean {
  if (
    action === "hotkey" ||
    action === "press" ||
    action === "key_down" ||
    action === "key_up" ||
    action === "key_hold" ||
    action === "mouse_down" ||
    action === "mouse_up" ||
    action === "mouse_hold"
  ) {
    return true;
  }
  if (action === "type") {
    const text = typeof params.text === "string" ? params.text : "";
    return text.trim().length > 0;
  }
  if (action === "drag") {
    return true;
  }
  if (action === "set_value_text") {
    const value = typeof params.value === "string" ? params.value : "";
    const valueFallback = typeof params.valueFallback === "boolean" ? params.valueFallback : true;
    return valueFallback && value.trim().length > 0;
  }
  if (action === "click" || action === "click_text" || action === "click_text_uia") {
    const button = typeof params.button === "string" ? params.button.trim().toLowerCase() : "left";
    const clicks = typeof params.clicks === "number" && Number.isFinite(params.clicks) ? params.clicks : 1;
    return button !== "left" || clicks > 1;
  }
  if (action === "dblclick" || action === "right_click") {
    return true;
  }
  return false;
}

function shouldApproveAction(params: {
  action: ComputerToolAction;
  confirm: ComputerConfirmMode;
  rawParams: Record<string, unknown>;
  uiHit?: UiHitTestResult | null;
  uiHitMatchers?: RegExp[];
}): boolean {
  const { action, confirm, rawParams } = params;
  if (confirm === "off") {
    return false;
  }
  if (
    action === "snapshot" ||
    action === "wait" ||
    action === "release" ||
    action === "reset_focus" ||
    action === "find" ||
    action === "focus_text"
  ) {
    return false;
  }
  if (action.startsWith("teach_")) {
    return false;
  }
  if (confirm === "always") {
    return true;
  }
  if ((action === "click" || action === "click_text" || action === "click_text_uia") && params.uiHit && params.uiHitMatchers) {
    if (isDangerousUiHit(params.uiHit, params.uiHitMatchers)) {
      return true;
    }
  }
  return isDangerousAction(action, rawParams);
}

function formatApprovalCommand(action: string, params: Record<string, unknown>): string {
  const allowedKeys = [
    "x",
    "y",
    "x2",
    "y2",
    "button",
    "clicks",
    "deltaY",
    "text",
    "match",
    "caseSensitive",
    "controlType",
    "maxResults",
    "resultIndex",
    "focusMode",
    "value",
    "valueFallback",
    "invokeFallback",
    "escCount",
    "key",
    "ctrl",
    "alt",
    "shift",
    "meta",
    "delayMs",
    "durationMs",
    "steps",
    "stepDelayMs",
    "jitterPx",
  ];
  const parts: string[] = [];
  for (const key of allowedKeys) {
    if (!(key in params)) {
      continue;
    }
    const value = params[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      const clipped = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
      parts.push(`${key}=${JSON.stringify(clipped)}`);
    } else {
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  return `${action}${parts.length ? " " + parts.join(" ") : ""}`;
}

async function recordTeachStep(params: {
  agentDir: string;
  sessionKey: string;
  action: string;
  stepParams: Record<string, unknown>;
}): Promise<void> {
  const existing = await loadTeachState({ agentDir: params.agentDir, sessionKey: params.sessionKey });
  if (!existing) {
    return;
  }
  const next: TeachState = {
    ...existing,
    steps: [
      ...existing.steps,
      {
        id: crypto.randomUUID(),
        atMs: Date.now(),
        action: params.action,
        params: params.stepParams,
      },
    ],
  };
  await saveTeachState({ agentDir: params.agentDir, sessionKey: params.sessionKey, state: next });
}

async function writeSkillFromTeachState(params: {
  workspaceDir: string;
  state: TeachState;
}): Promise<{ skillName: string; skillDir: string }> {
  const skillName = autoSkillName();
  const skillDir = path.join(params.workspaceDir, "skills", skillName);
  await fs.mkdir(skillDir, { recursive: true });

  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${skillName}`);
  lines.push('description: "Recorded Windows desktop automation steps (computer tool)."');
  lines.push("---");
  lines.push("");
  lines.push("# Recorded Desktop Flow");
  lines.push("");
  lines.push("This skill was generated from an interactive teaching session.");
  lines.push("");
  lines.push("## How To Run");
  lines.push("");
  lines.push("Repeat the loop: take a snapshot, then perform one action, then re-snapshot.");
  lines.push("");
  lines.push("## Steps");
  lines.push("");

  const steps = params.state.steps;
  if (steps.length === 0) {
    lines.push("(No steps were recorded.)");
  } else {
    for (const [i, step] of steps.entries()) {
      const details = JSON.stringify(step.params);
      lines.push(`${i + 1}. ${step.action} ${details}`);
    }
  }
  lines.push("");

  await fs.writeFile(path.join(skillDir, "SKILL.md"), lines.join("\n"), "utf-8");
  return { skillName, skillDir };
}

async function renameSkillDir(params: {
  workspaceDir: string;
  fromName: string;
  toName: string;
}): Promise<{ fromDir: string; toDir: string }> {
  const safeTo = sanitizeSkillName(params.toName);
  if (!safeTo) {
    throw new Error("name required");
  }
  const fromDir = path.join(params.workspaceDir, "skills", params.fromName);
  const toDir = path.join(params.workspaceDir, "skills", safeTo);
  await fs.rename(fromDir, toDir);
  const skillMdPath = path.join(toDir, "SKILL.md");
  const raw = await fs.readFile(skillMdPath, "utf-8");
  const updated = raw.replace(/^name:\s*.*$/m, `name: ${safeTo}`);
  await fs.writeFile(skillMdPath, updated, "utf-8");
  return { fromDir, toDir };
}

async function resolveSnapshot(params?: { overlay?: "none" | "grid" }): Promise<{
  base64: string;
  width: number;
  height: number;
  cursorX?: number;
  cursorY?: number;
}> {
  const overlay = params?.overlay === "none" ? "none" : "grid";
  const script = `
$ErrorActionPreference = 'Stop'

$overlay = '${overlay}'

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Dpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[void][Dpi]::SetProcessDPIAware()

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CursorPos {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT pt);
}
'@
$pt = New-Object CursorPos+POINT
[void][CursorPos]::GetCursorPos([ref]$pt)

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)

if ($overlay -eq 'grid') {
  $step = 100
  $labelStep = 200

  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(80, 0, 0, 0)), 1
  for ($x = 0; $x -lt $bounds.Width; $x += $step) {
    $gfx.DrawLine($pen, $x, 0, $x, $bounds.Height)
  }
  for ($y = 0; $y -lt $bounds.Height; $y += $step) {
    $gfx.DrawLine($pen, 0, $y, $bounds.Width, $y)
  }

  $font = New-Object System.Drawing.Font 'Consolas', 12
  $textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(220, 255, 255, 255))
  $bgBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(140, 0, 0, 0))

  for ($x = 0; $x -lt $bounds.Width; $x += $labelStep) {
    $label = [string]$x
    $size = $gfx.MeasureString($label, $font)
    $gfx.FillRectangle($bgBrush, $x + 2, 2, $size.Width, $size.Height)
    $gfx.DrawString($label, $font, $textBrush, $x + 2, 2)
  }
  for ($y = 0; $y -lt $bounds.Height; $y += $labelStep) {
    $label = [string]$y
    $size = $gfx.MeasureString($label, $font)
    $gfx.FillRectangle($bgBrush, 2, $y + 2, $size.Width, $size.Height)
    $gfx.DrawString($label, $font, $textBrush, 2, $y + 2)
  }

  $cursorPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(220, 255, 0, 0)), 2
  $gfx.DrawLine($cursorPen, $pt.X - 12, $pt.Y, $pt.X + 12, $pt.Y)
  $gfx.DrawLine($cursorPen, $pt.X, $pt.Y - 12, $pt.X, $pt.Y + 12)
}

$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$base64 = [Convert]::ToBase64String($ms.ToArray())

$out = @{ base64 = $base64; width = $bounds.Width; height = $bounds.Height; cursorX = $pt.X; cursorY = $pt.Y; overlay = $overlay } | ConvertTo-Json -Compress
Write-Output $out
`;


  return await runPowerShellJson({ script, timeoutMs: 60_000 });
}

async function runInputAction(params: {
  action: string;
  args: Record<string, unknown>;
}): Promise<void> {
  const action = params.action;
  const json = JSON.stringify(params.args ?? {});
  const jsonB64 = Buffer.from(json, "utf-8").toString("base64");

  const script = `
$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Dpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[void][Dpi]::SetProcessDPIAware()

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class InputApi {
  public const int INPUT_MOUSE = 0;
  public const int INPUT_KEYBOARD = 1;

  public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;

  public const uint MOUSEEVENTF_MOVE = 0x0001;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

  public const int SM_CXSCREEN = 0;
  public const int SM_CYSCREEN = 1;

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }

  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out POINT pt);

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public int type;
    public InputUnion U;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)]
    public MOUSEINPUT mi;

    [FieldOffset(0)]
    public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [DllImport("user32.dll")]
  public static extern int GetSystemMetrics(int nIndex);

  public static INPUT MakeKey(ushort vk, ushort scan, uint flags) {
    var input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.U = new InputUnion();
    input.U.ki = new KEYBDINPUT();
    input.U.ki.wVk = vk;
    input.U.ki.wScan = scan;
    input.U.ki.dwFlags = flags;
    input.U.ki.time = 0;
    input.U.ki.dwExtraInfo = IntPtr.Zero;
    return input;
  }

  public static INPUT MakeMouse(int dx, int dy, uint mouseData, uint flags) {
    var input = new INPUT();
    input.type = INPUT_MOUSE;
    input.U = new InputUnion();
    input.U.mi = new MOUSEINPUT();
    input.U.mi.dx = dx;
    input.U.mi.dy = dy;
    input.U.mi.mouseData = mouseData;
    input.U.mi.dwFlags = flags;
    input.U.mi.time = 0;
    input.U.mi.dwExtraInfo = IntPtr.Zero;
    return input;
  }

  public static void Send(INPUT[] inputs) {
    SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }

  public static int Clamp(int value, int min, int max) {
    if (value < min) {
      return min;
    }
    if (value > max) {
      return max;
    }
    return value;
  }

  public static int ToAbsoluteCoord(int px, int span) {
    if (span <= 1) {
      return 0;
    }
    double scaled = (double)px * 65535.0 / (double)(span - 1);
    int rounded = (int)Math.Round(scaled);
    return Clamp(rounded, 0, 65535);
  }
}

public static class Keyboard {
  public static void KeyDown(ushort vk, bool extended) {
    uint flags = extended ? InputApi.KEYEVENTF_EXTENDEDKEY : 0;
    InputApi.INPUT[] inputs = new InputApi.INPUT[] { InputApi.MakeKey(vk, 0, flags) };
    InputApi.Send(inputs);
  }

  public static void KeyUp(ushort vk, bool extended) {
    uint flags = InputApi.KEYEVENTF_KEYUP | (extended ? InputApi.KEYEVENTF_EXTENDEDKEY : 0);
    InputApi.INPUT[] inputs = new InputApi.INPUT[] { InputApi.MakeKey(vk, 0, flags) };
    InputApi.Send(inputs);
  }

  public static void KeyPress(ushort vk, bool extended) {
    KeyDown(vk, extended);
    KeyUp(vk, extended);
  }

  public static void TypeUnicode(string text) {
    if (string.IsNullOrEmpty(text)) {
      return;
    }
    foreach (var ch in text) {
      InputApi.INPUT down = InputApi.MakeKey(0, (ushort)ch, InputApi.KEYEVENTF_UNICODE);
      InputApi.INPUT up = InputApi.MakeKey(0, (ushort)ch, InputApi.KEYEVENTF_UNICODE | InputApi.KEYEVENTF_KEYUP);
      InputApi.INPUT[] inputs = new InputApi.INPUT[] { down, up };
      InputApi.Send(inputs);
    }
  }

  public static void Combo(bool ctrl, bool alt, bool shift, bool meta, ushort vk, bool extended) {
    if (ctrl) {
      KeyDown(0x11, false);
    }
    if (alt) {
      KeyDown(0x12, false);
    }
    if (shift) {
      KeyDown(0x10, false);
    }
    if (meta) {
      KeyDown(0x5B, false);
    }
    KeyPress(vk, extended);
    if (meta) {
      KeyUp(0x5B, false);
    }
    if (shift) {
      KeyUp(0x10, false);
    }
    if (alt) {
      KeyUp(0x12, false);
    }
    if (ctrl) {
      KeyUp(0x11, false);
    }
  }
}

public static class MouseInput {
  public static void MoveTo(int x, int y) {
    int width = InputApi.GetSystemMetrics(InputApi.SM_CXSCREEN);
    int height = InputApi.GetSystemMetrics(InputApi.SM_CYSCREEN);
    int absX = InputApi.ToAbsoluteCoord(x, width);
    int absY = InputApi.ToAbsoluteCoord(y, height);
    InputApi.INPUT move = InputApi.MakeMouse(absX, absY, 0, InputApi.MOUSEEVENTF_MOVE | InputApi.MOUSEEVENTF_ABSOLUTE);
    InputApi.Send(new InputApi.INPUT[] { move });
  }

  static uint ResolveDownFlag(string button) {
    string b = (button ?? "left").ToLowerInvariant();
    if (b == "right") {
      return InputApi.MOUSEEVENTF_RIGHTDOWN;
    }
    if (b == "middle") {
      return InputApi.MOUSEEVENTF_MIDDLEDOWN;
    }
    return InputApi.MOUSEEVENTF_LEFTDOWN;
  }

  static uint ResolveUpFlag(string button) {
    string b = (button ?? "left").ToLowerInvariant();
    if (b == "right") {
      return InputApi.MOUSEEVENTF_RIGHTUP;
    }
    if (b == "middle") {
      return InputApi.MOUSEEVENTF_MIDDLEUP;
    }
    return InputApi.MOUSEEVENTF_LEFTUP;
  }

  public static void ButtonDown(string button) {
    uint down = ResolveDownFlag(button);
    InputApi.Send(new InputApi.INPUT[] { InputApi.MakeMouse(0, 0, 0, down) });
  }

  public static void ButtonUp(string button) {
    uint up = ResolveUpFlag(button);
    InputApi.Send(new InputApi.INPUT[] { InputApi.MakeMouse(0, 0, 0, up) });
  }

  public static void Click(string button, int clicks) {
    Click(button, clicks, 60, 25);
  }

  public static void Click(string button, int clicks, int intervalMs, int jitterMs) {
    int count = clicks < 1 ? 1 : clicks;
    uint down = ResolveDownFlag(button);
    uint up = ResolveUpFlag(button);

    int baseInterval = intervalMs < 0 ? 0 : intervalMs;
    int jitter = jitterMs < 0 ? 0 : jitterMs;
    var rng = new Random();

    for (int i = 0; i < count; i++) {
      InputApi.Send(new InputApi.INPUT[] { InputApi.MakeMouse(0, 0, 0, down), InputApi.MakeMouse(0, 0, 0, up) });
      if (i < count - 1) {
        int ms = baseInterval;
        if (jitter > 0) {
          ms += rng.Next(-jitter, jitter + 1);
        }
        if (ms > 0) {
          System.Threading.Thread.Sleep(ms);
        }
      }
    }
  }

  public static void Wheel(int delta) {
    uint data = unchecked((uint)delta);
    InputApi.Send(new InputApi.INPUT[] { InputApi.MakeMouse(0, 0, data, InputApi.MOUSEEVENTF_WHEEL) });
  }
}
'@

function Get-Args() {
  $b64 = '${jsonB64}'
  $raw = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
  return ($raw | ConvertFrom-Json)
}

$args = Get-Args
$delayMs = 0
if ($args.PSObject.Properties.Name -contains 'delayMs') { $delayMs = [int]$args.delayMs }

function Sleep-IfNeeded() {
  if ($delayMs -gt 0) { Start-Sleep -Milliseconds $delayMs }
}

function Resolve-Key([string]$keyToken) {
  if (-not $keyToken) { throw 'key required' }
  $k = $keyToken.Trim()
  if ($k.StartsWith('{') -and $k.EndsWith('}')) {
    $k = $k.Substring(1, $k.Length - 2)
  }
  $k = $k.Trim()
  if (-not $k) { throw 'key required' }

  $upper = $k.ToUpperInvariant()
  $extended = $false
  $vk = $null

  switch ($upper) {
    'ENTER' { $vk = 0x0D }
    'TAB' { $vk = 0x09 }
    'ESC' { $vk = 0x1B }
    'ESCAPE' { $vk = 0x1B }
    'BACKSPACE' { $vk = 0x08 }
    'DELETE' { $vk = 0x2E; $extended = $true }
    'INSERT' { $vk = 0x2D; $extended = $true }
    'HOME' { $vk = 0x24; $extended = $true }
    'END' { $vk = 0x23; $extended = $true }
    'PGUP' { $vk = 0x21; $extended = $true }
    'PAGEUP' { $vk = 0x21; $extended = $true }
    'PGDN' { $vk = 0x22; $extended = $true }
    'PAGEDOWN' { $vk = 0x22; $extended = $true }
    'UP' { $vk = 0x26; $extended = $true }
    'DOWN' { $vk = 0x28; $extended = $true }
    'LEFT' { $vk = 0x25; $extended = $true }
    'RIGHT' { $vk = 0x27; $extended = $true }
    'SPACE' { $vk = 0x20 }
    'SHIFT' { $vk = 0x10 }
    'LSHIFT' { $vk = 0xA0 }
    'RSHIFT' { $vk = 0xA1 }
    'CTRL' { $vk = 0x11 }
    'CONTROL' { $vk = 0x11 }
    'LCTRL' { $vk = 0xA2 }
    'RCTRL' { $vk = 0xA3; $extended = $true }
    'ALT' { $vk = 0x12 }
    'LALT' { $vk = 0xA4 }
    'RALT' { $vk = 0xA5; $extended = $true }
    'WIN' { $vk = 0x5B }
    'LWIN' { $vk = 0x5B }
    'RWIN' { $vk = 0x5C }
    default {
      if ($upper -match '^F(\d{1,2})$') {
        $n = [int]$Matches[1]
        if ($n -ge 1 -and $n -le 24) {
          $vk = 0x70 + ($n - 1)
        }
      } elseif ($upper.Length -eq 1) {
        $vk = [int][byte][char]$upper
      }
    }
  }

  if ($vk -eq $null) {
    throw "unsupported key token: $upper"
  }

  return @{ vk = [UInt16]$vk; extended = $extended }
}

$rng = New-Object System.Random

function Smooth-MoveTo([int]$x2, [int]$y2, [int]$steps, [int]$stepDelay, [int]$jitterPx) {
  if ($steps -lt 1) { $steps = 1 }
  if ($steps -gt 200) { $steps = 200 }
  if ($stepDelay -lt 0) { $stepDelay = 0 }
  if ($stepDelay -gt 200) { $stepDelay = 200 }

  if ($jitterPx -lt 0) { $jitterPx = 0 }
  if ($jitterPx -gt 6) { $jitterPx = 6 }

  $pt = New-Object InputApi+POINT
  [void][InputApi]::GetCursorPos([ref]$pt)
  $x1 = [int]$pt.X
  $y1 = [int]$pt.Y

  if ($steps -eq 1) {
    [MouseInput]::MoveTo($x2, $y2)
    return
  }

  $dx = ($x2 - $x1)
  $dy = ($y2 - $y1)

  $phaseX = $rng.NextDouble() * 6.283185
  $phaseY = $rng.NextDouble() * 6.283185
  $freqX = 1.0 + ($rng.NextDouble() * 2.0)
  $freqY = 1.0 + ($rng.NextDouble() * 2.0)

  for ($i = 1; $i -le $steps; $i++) {
    $t = $i / [double]$steps
    $e = ($t * $t) * (3.0 - (2.0 * $t))

    $jx = 0.0
    $jy = 0.0
    if ($jitterPx -gt 0) {
      $decay = 4.0 * $t * (1.0 - $t)
      $jx = [Math]::Sin($phaseX + ($t * $freqX * 6.283185)) * $jitterPx * $decay
      $jy = [Math]::Sin($phaseY + ($t * $freqY * 6.283185)) * $jitterPx * $decay
    }

    $nx = [int][Math]::Round($x1 + ($dx * $e) + $jx)
    $ny = [int][Math]::Round($y1 + ($dy * $e) + $jy)
    [MouseInput]::MoveTo($nx, $ny)
    if ($stepDelay -gt 0) { Start-Sleep -Milliseconds $stepDelay }
  }
}

switch ('${action}') {
  'hover' {
    $x = [int]$args.x
    $y = [int]$args.y

    $duration = 250
    if ($args.PSObject.Properties.Name -contains 'durationMs') { $duration = [int]$args.durationMs }
    if ($duration -lt 0) { $duration = 0 }
    if ($duration -gt 10000) { $duration = 10000 }

    $steps = 12
    if ($args.PSObject.Properties.Name -contains 'steps') { $steps = [int]$args.steps }

    $stepDelay = 6
    if ($args.PSObject.Properties.Name -contains 'stepDelayMs') { $stepDelay = [int]$args.stepDelayMs }

    $jitter = 1
    if ($args.PSObject.Properties.Name -contains 'jitterPx') { $jitter = [int]$args.jitterPx }

    Smooth-MoveTo $x $y $steps $stepDelay $jitter
    if ($duration -gt 0) { Start-Sleep -Milliseconds $duration }
    Sleep-IfNeeded
  }
  'move' {
    $x2 = [int]$args.x
    $y2 = [int]$args.y

    $steps = 15
    if ($args.PSObject.Properties.Name -contains 'steps') { $steps = [int]$args.steps }

    $stepDelay = 5
    if ($args.PSObject.Properties.Name -contains 'stepDelayMs') { $stepDelay = [int]$args.stepDelayMs }

    $jitter = 1
    if ($args.PSObject.Properties.Name -contains 'jitterPx') { $jitter = [int]$args.jitterPx }

    Smooth-MoveTo $x2 $y2 $steps $stepDelay $jitter
    Sleep-IfNeeded
  }
  'click' {
    $x = [int]$args.x
    $y = [int]$args.y

    $steps = 8
    if ($args.PSObject.Properties.Name -contains 'steps') { $steps = [int]$args.steps }

    $stepDelay = 5
    if ($args.PSObject.Properties.Name -contains 'stepDelayMs') { $stepDelay = [int]$args.stepDelayMs }

    $jitter = 1
    if ($args.PSObject.Properties.Name -contains 'jitterPx') { $jitter = [int]$args.jitterPx }

    Smooth-MoveTo $x $y $steps $stepDelay $jitter

    $button = 'left'
    if ($args.PSObject.Properties.Name -contains 'button') { $button = [string]$args.button }
    $clicks = 1
    if ($args.PSObject.Properties.Name -contains 'clicks') { $clicks = [int]$args.clicks }
    if ($clicks -lt 1) { $clicks = 1 }

    [MouseInput]::Click($button, $clicks)
    Sleep-IfNeeded
  }
  'mouse_down' {
    $button = 'left'
    if ($args.PSObject.Properties.Name -contains 'button') { $button = [string]$args.button }

    if ($args.PSObject.Properties.Name -contains 'x' -and $args.PSObject.Properties.Name -contains 'y') {
      $x = [int]$args.x
      $y = [int]$args.y

      $steps = 10
      if ($args.PSObject.Properties.Name -contains 'steps') { $steps = [int]$args.steps }

      $stepDelay = 6
      if ($args.PSObject.Properties.Name -contains 'stepDelayMs') { $stepDelay = [int]$args.stepDelayMs }

      $jitter = 1
      if ($args.PSObject.Properties.Name -contains 'jitterPx') { $jitter = [int]$args.jitterPx }

      Smooth-MoveTo $x $y $steps $stepDelay $jitter
    }

    [MouseInput]::ButtonDown($button)
    Sleep-IfNeeded
  }
  'mouse_up' {
    $button = 'left'
    if ($args.PSObject.Properties.Name -contains 'button') { $button = [string]$args.button }

    if ($args.PSObject.Properties.Name -contains 'x' -and $args.PSObject.Properties.Name -contains 'y') {
      $x = [int]$args.x
      $y = [int]$args.y

      $steps = 10
      if ($args.PSObject.Properties.Name -contains 'steps') { $steps = [int]$args.steps }

      $stepDelay = 6
      if ($args.PSObject.Properties.Name -contains 'stepDelayMs') { $stepDelay = [int]$args.stepDelayMs }

      $jitter = 1
      if ($args.PSObject.Properties.Name -contains 'jitterPx') { $jitter = [int]$args.jitterPx }

      Smooth-MoveTo $x $y $steps $stepDelay $jitter
    }

    [MouseInput]::ButtonUp($button)
    Sleep-IfNeeded
  }
  'mouse_hold' {
    $button = 'left'
    if ($args.PSObject.Properties.Name -contains 'button') { $button = [string]$args.button }

    $duration = 250
    if ($args.PSObject.Properties.Name -contains 'durationMs') { $duration = [int]$args.durationMs }
    if ($duration -lt 0) { $duration = 0 }
    if ($duration -gt 10000) { $duration = 10000 }

    if ($args.PSObject.Properties.Name -contains 'x' -and $args.PSObject.Properties.Name -contains 'y') {
      $x = [int]$args.x
      $y = [int]$args.y

      $steps = 10
      if ($args.PSObject.Properties.Name -contains 'steps') { $steps = [int]$args.steps }

      $stepDelay = 6
      if ($args.PSObject.Properties.Name -contains 'stepDelayMs') { $stepDelay = [int]$args.stepDelayMs }

      $jitter = 1
      if ($args.PSObject.Properties.Name -contains 'jitterPx') { $jitter = [int]$args.jitterPx }

      Smooth-MoveTo $x $y $steps $stepDelay $jitter
    }

    [MouseInput]::ButtonDown($button)
    if ($duration -gt 0) { Start-Sleep -Milliseconds $duration }
    [MouseInput]::ButtonUp($button)
    Sleep-IfNeeded
  }
  'scroll' {
    if ($args.PSObject.Properties.Name -contains 'x' -and $args.PSObject.Properties.Name -contains 'y') {
      $x = [int]$args.x
      $y = [int]$args.y

      $steps = 8
      if ($args.PSObject.Properties.Name -contains 'steps') { $steps = [int]$args.steps }

      $stepDelay = 5
      if ($args.PSObject.Properties.Name -contains 'stepDelayMs') { $stepDelay = [int]$args.stepDelayMs }

     $jitter = 1
     if ($args.PSObject.Properties.Name -contains 'jitterPx') { $jitter = [int]$args.jitterPx }

     Smooth-MoveTo $x $y $steps $stepDelay $jitter
    }
    $delta = [int]$args.deltaY
    [MouseInput]::Wheel($delta)
    Sleep-IfNeeded
  }
  'drag' {
    $x1 = [int]$args.x
    $y1 = [int]$args.y
    $x2 = [int]$args.x2
    $y2 = [int]$args.y2

    $steps = 25
    if ($args.PSObject.Properties.Name -contains 'steps') { $steps = [int]$args.steps }
    if ($steps -lt 1) { $steps = 1 }
    if ($steps -gt 200) { $steps = 200 }

    $stepDelay = 10
    if ($args.PSObject.Properties.Name -contains 'stepDelayMs') { $stepDelay = [int]$args.stepDelayMs }
    if ($stepDelay -lt 0) { $stepDelay = 0 }
    if ($stepDelay -gt 200) { $stepDelay = 200 }

    [MouseInput]::MoveTo($x1, $y1)
    Start-Sleep -Milliseconds 20
    [MouseInput]::ButtonDown('left')
    Start-Sleep -Milliseconds 30

    $jitter = 1
    if ($args.PSObject.Properties.Name -contains 'jitterPx') { $jitter = [int]$args.jitterPx }

    if ($steps -eq 1) {
      [MouseInput]::MoveTo($x2, $y2)
    } else {
      $dx = ($x2 - $x1)
      $dy = ($y2 - $y1)

      if ($jitter -lt 0) { $jitter = 0 }
      if ($jitter -gt 6) { $jitter = 6 }
      $phaseX = $rng.NextDouble() * 6.283185
      $phaseY = $rng.NextDouble() * 6.283185
      $freqX = 1.0 + ($rng.NextDouble() * 2.0)
      $freqY = 1.0 + ($rng.NextDouble() * 2.0)

      for ($i = 1; $i -le $steps; $i++) {
        $t = $i / [double]$steps
        $e = ($t * $t) * (3.0 - (2.0 * $t))

        $jx = 0.0
        $jy = 0.0
        if ($jitter -gt 0) {
          $decay = 4.0 * $t * (1.0 - $t)
          $jx = [Math]::Sin($phaseX + ($t * $freqX * 6.283185)) * $jitter * $decay
          $jy = [Math]::Sin($phaseY + ($t * $freqY * 6.283185)) * $jitter * $decay
        }

        $nx = [int][Math]::Round($x1 + ($dx * $e) + $jx)
        $ny = [int][Math]::Round($y1 + ($dy * $e) + $jy)
        [MouseInput]::MoveTo($nx, $ny)
        if ($stepDelay -gt 0) { Start-Sleep -Milliseconds $stepDelay }
      }
    }

    Start-Sleep -Milliseconds 30
    [MouseInput]::ButtonUp('left')
    Sleep-IfNeeded
  }
  'type' {
    if (-not ($args.PSObject.Properties.Name -contains 'text')) { throw 'text required' }
    $text = [string]$args.text
    [Keyboard]::TypeUnicode($text)
    Sleep-IfNeeded
  }
  'key_down' {
    $keyToken = [string]$args.key
    if (-not $keyToken) { throw 'key required' }
    $resolved = Resolve-Key $keyToken
    [Keyboard]::KeyDown([UInt16]$resolved.vk, [bool]$resolved.extended)
    Sleep-IfNeeded
  }
  'key_up' {
    $keyToken = [string]$args.key
    if (-not $keyToken) { throw 'key required' }
    $resolved = Resolve-Key $keyToken
    [Keyboard]::KeyUp([UInt16]$resolved.vk, [bool]$resolved.extended)
    Sleep-IfNeeded
  }
  'key_hold' {
    $keyToken = [string]$args.key
    if (-not $keyToken) { throw 'key required' }

    $duration = 250
    if ($args.PSObject.Properties.Name -contains 'durationMs') { $duration = [int]$args.durationMs }
    if ($duration -lt 0) { $duration = 0 }
    if ($duration -gt 10000) { $duration = 10000 }

    $resolved = Resolve-Key $keyToken
    [Keyboard]::KeyDown([UInt16]$resolved.vk, [bool]$resolved.extended)
    if ($duration -gt 0) { Start-Sleep -Milliseconds $duration }
    [Keyboard]::KeyUp([UInt16]$resolved.vk, [bool]$resolved.extended)
    Sleep-IfNeeded
  }
  'release' {
    # Mouse buttons
    [MouseInput]::ButtonUp('left')
    [MouseInput]::ButtonUp('right')
    [MouseInput]::ButtonUp('middle')

    # Modifiers / common stuck keys
    [Keyboard]::KeyUp(0x10, $false) # SHIFT
    [Keyboard]::KeyUp(0xA0, $false) # LSHIFT
    [Keyboard]::KeyUp(0xA1, $false) # RSHIFT
    [Keyboard]::KeyUp(0x11, $false) # CTRL
    [Keyboard]::KeyUp(0xA2, $false) # LCTRL
    [Keyboard]::KeyUp(0xA3, $true)  # RCTRL
    [Keyboard]::KeyUp(0x12, $false) # ALT
    [Keyboard]::KeyUp(0xA4, $false) # LALT
    [Keyboard]::KeyUp(0xA5, $true)  # RALT
    [Keyboard]::KeyUp(0x5B, $false) # LWIN
    [Keyboard]::KeyUp(0x5C, $false) # RWIN

    Sleep-IfNeeded
  }
  'reset_focus' {
    # First, release any potentially stuck input.
    [MouseInput]::ButtonUp('left')
    [MouseInput]::ButtonUp('right')
    [MouseInput]::ButtonUp('middle')

    [Keyboard]::KeyUp(0x10, $false) # SHIFT
    [Keyboard]::KeyUp(0xA0, $false) # LSHIFT
    [Keyboard]::KeyUp(0xA1, $false) # RSHIFT
    [Keyboard]::KeyUp(0x11, $false) # CTRL
    [Keyboard]::KeyUp(0xA2, $false) # LCTRL
    [Keyboard]::KeyUp(0xA3, $true)  # RCTRL
    [Keyboard]::KeyUp(0x12, $false) # ALT
    [Keyboard]::KeyUp(0xA4, $false) # LALT
    [Keyboard]::KeyUp(0xA5, $true)  # RALT
    [Keyboard]::KeyUp(0x5B, $false) # LWIN
    [Keyboard]::KeyUp(0x5C, $false) # RWIN

    $count = 2
    if ($args.PSObject.Properties.Name -contains 'escCount') { $count = [int]$args.escCount }
    if ($count -lt 1) { $count = 1 }
    if ($count -gt 5) { $count = 5 }

    for ($i = 0; $i -lt $count; $i++) {
      [Keyboard]::KeyPress(0x1B, $false) # ESC
      Start-Sleep -Milliseconds 80
    }

    Sleep-IfNeeded
  }
  'hotkey' {
    $keyToken = [string]$args.key
    if (-not $keyToken) { throw 'key required' }
    $ctrl = $false; $alt = $false; $shift = $false; $meta = $false
    if ($args.PSObject.Properties.Name -contains 'ctrl') { $ctrl = [bool]$args.ctrl }
    if ($args.PSObject.Properties.Name -contains 'alt') { $alt = [bool]$args.alt }
    if ($args.PSObject.Properties.Name -contains 'shift') { $shift = [bool]$args.shift }
    if ($args.PSObject.Properties.Name -contains 'meta') { $meta = [bool]$args.meta }

    $resolved = Resolve-Key $keyToken
    [Keyboard]::Combo($ctrl, $alt, $shift, $meta, [UInt16]$resolved.vk, [bool]$resolved.extended)
    Sleep-IfNeeded
  }
  'press' {
    $keyToken = [string]$args.key
    if (-not $keyToken) { throw 'key required' }
    $resolved = Resolve-Key $keyToken
    [Keyboard]::KeyPress([UInt16]$resolved.vk, [bool]$resolved.extended)
    Sleep-IfNeeded
  }
  default {
    throw 'unsupported action'
  }
}

@{ ok = $true } | ConvertTo-Json -Compress | Write-Output
`;

  await runPowerShellJson({ script, timeoutMs: 30_000 });
}

export function createComputerTool(options?: {
  agentSessionKey?: string;
  agentDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  const sessionKey = options?.agentSessionKey?.trim() || "main";
  const agentDir = options?.agentDir?.trim() || undefined;
  const workspaceDir = options?.workspaceDir?.trim() || undefined;

  const allowAlwaysCache = new Set<string>();

  return {
    label: "Computer",
    name: "computer",
    description:
      "Windows-only computer use: take screenshots and control mouse/keyboard. Actions require approval via Web UI.",
    parameters: ComputerToolSchema,
    execute: async (_toolCallId, args) => {
      if (process.platform !== "win32") {
        throw new Error("computer tool is only supported on Windows");
      }

      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true }) as ComputerToolAction;
      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      };

      const confirmRaw = readStringParam(params, "confirm", { required: false });
      const confirmFromConfig = options?.config?.tools?.computer?.confirm;
      const confirmValue = (confirmRaw ?? confirmFromConfig ?? "always").trim();
      const confirm: ComputerConfirmMode =
        confirmValue === "off" || confirmValue === "dangerous" || confirmValue === "always"
          ? (confirmValue as ComputerConfirmMode)
          : "always";

      const dangerTokensRaw = options?.config?.tools?.computer?.dangerTokens;
      const dangerTokens = Array.isArray(dangerTokensRaw)
        ? dangerTokensRaw
            .filter((t): t is string => typeof t === "string")
            .map((t) => t.trim())
            .filter(Boolean)
        : [];
      const uiHitMatchers = dangerTokens.length > 0 ? compileDangerMatchers(dangerTokens) : DEFAULT_UI_HIT_MATCHERS;

      if (action === "snapshot") {
        const overlayRaw = readStringParam(params, "overlay", { required: false });
        const overlay = overlayRaw === "none" || overlayRaw === "dual" ? overlayRaw : "grid";

        if (overlay === "dual") {
          const raw = await resolveSnapshot({ overlay: "none" });
          const grid = await resolveSnapshot({ overlay: "grid" });

          const rawBuf = Buffer.from(raw.base64, "base64");
          const gridBuf = Buffer.from(grid.base64, "base64");

          const rawSaved = await saveMediaBuffer(rawBuf, "image/png", "computer", 20 * 1024 * 1024);
          const gridSaved = await saveMediaBuffer(gridBuf, "image/png", "computer", 20 * 1024 * 1024);

          const result: AgentToolResult<unknown> = {
            content: [
              { type: "text", text: `MEDIA:${rawSaved.path}` },
              { type: "image", data: raw.base64, mimeType: "image/png" },
              { type: "text", text: `MEDIA:${gridSaved.path}` },
              { type: "image", data: grid.base64, mimeType: "image/png" },
            ],
            details: {
              raw: { path: rawSaved.path, width: raw.width, height: raw.height },
              grid: { path: gridSaved.path, width: grid.width, height: grid.height },
              cursorX: raw.cursorX,
              cursorY: raw.cursorY,
            },
          };

          return await sanitizeToolResultImages(result, "computer.snapshot");
        }

        const snap = await resolveSnapshot({ overlay: overlay === "none" ? "none" : "grid" });
        const buffer = Buffer.from(snap.base64, "base64");
        const saved = await saveMediaBuffer(buffer, "image/png", "computer", 20 * 1024 * 1024);
        return await imageResultFromFile({
          label: "computer.snapshot",
          path: saved.path,
          details: {
            width: snap.width,
            height: snap.height,
            cursorX: snap.cursorX,
            cursorY: snap.cursorY,
          },
        });
      }

      if (action === "wait") {
        const durationMs = readPositiveInt(params, "durationMs", 500);
        await new Promise((resolve) => setTimeout(resolve, durationMs));
        if (agentDir) {
          await recordTeachStep({
            agentDir,
            sessionKey,
            action: "wait",
            stepParams: { durationMs },
          });
        }
        return jsonResult({ ok: true, waitedMs: durationMs });
      }

      if (action === "release") {
        await runInputAction({ action: "release", args: {} });
        return jsonResult({ ok: true });
      }

      if (action === "reset_focus") {
        const escCount = Math.min(5, readPositiveInt(params, "escCount", 2));
        await runInputAction({ action: "reset_focus", args: { escCount } });
        return jsonResult({ ok: true });
      }

      if (action === "hover") {
        const x = requireNumber(params, "x");
        const y = requireNumber(params, "y");
        const durationMs = readPositiveInt(params, "durationMs", 250);
        const steps = readPositiveInt(params, "steps", 12);
        const stepDelayMs = readPositiveInt(params, "stepDelayMs", 6);
        const jitterPx = readNonNegativeInt(params, "jitterPx", 1);
        await runInputAction({
          action: "hover",
          args: { x, y, durationMs, steps, stepDelayMs, jitterPx },
        });
        if (agentDir) {
          await recordTeachStep({
            agentDir,
            sessionKey,
            action: "hover",
            stepParams: { x, y, durationMs, steps, stepDelayMs, jitterPx },
          });
        }
        return jsonResult({ ok: true });
      }

      if (action === "teach_start") {
        if (!agentDir) {
          throw new Error("agentDir required for teach mode");
        }
        const next: TeachState = {
          version: 1,
          startedAtMs: Date.now(),
          steps: [],
        };
        await saveTeachState({ agentDir, sessionKey, state: next });
        return jsonResult({ ok: true, status: "teach-started" });
      }

      if (action === "teach_finish") {
        if (!agentDir) {
          throw new Error("agentDir required for teach mode");
        }
        if (!workspaceDir) {
          throw new Error("workspaceDir required for teach mode");
        }
        const state = await loadTeachState({ agentDir, sessionKey });
        if (!state) {
          throw new Error("teach mode not started");
        }
        const out = await writeSkillFromTeachState({ workspaceDir, state });
        const updated: TeachState = { ...state, skillDir: out.skillDir };
        await saveTeachState({ agentDir, sessionKey, state: updated });
        return jsonResult({ ok: true, status: "teach-finished", ...out });
      }

      if (action === "teach_rename") {
        if (!agentDir) {
          throw new Error("agentDir required for teach mode");
        }
        if (!workspaceDir) {
          throw new Error("workspaceDir required for teach mode");
        }
        const state = await loadTeachState({ agentDir, sessionKey });
        if (!state?.skillDir) {
          throw new Error("teach session has no generated skill yet (run teach_finish first)");
        }
        const fromName = path.basename(state.skillDir);
        const toName = readStringParam(params, "name", { required: true });
        const renamed = await renameSkillDir({ workspaceDir, fromName, toName });
        const next: TeachState = { ...state, skillDir: renamed.toDir };
        await saveTeachState({ agentDir, sessionKey, state: next });
        return jsonResult({ ok: true, status: "teach-renamed", toName: path.basename(renamed.toDir) });
      }

      let uiHit: UiHitTestResult | null = null;
      let approvalParams: Record<string, unknown> = params;
      let clickTextTarget: UiTextMatch | null = null;
      let clickTextMeta:
        | {
            text: string;
            match: "contains" | "exact" | "prefix";
            caseSensitive: boolean;
            controlType?: string;
            maxResults: number;
            resultIndex: number;
          }
        | null = null;
      let focusTarget: UiTextMatch | null = null;
      let invokeTarget: UiTextMatch | null = null;
      let invokeMeta:
        | {
            text: string;
            match: "contains" | "exact" | "prefix";
            caseSensitive: boolean;
            controlType?: string;
            maxResults: number;
            resultIndex: number;
          }
        | null = null;
      let setValueMeta:
        | {
            text: string;
            value: string;
            match: "contains" | "exact" | "prefix";
            caseSensitive: boolean;
            controlType?: string;
            maxResults: number;
            resultIndex: number;
            focusMode: "mouse" | "uia" | "auto";
            valueFallback: boolean;
          }
        | null = null;

      if (
        action === "find" ||
        action === "click_text" ||
        action === "click_text_uia" ||
        action === "focus_text" ||
        action === "set_value_text"
      ) {
        const text = readStringParam(params, "text", { required: true });
        const matchRaw = readStringParam(params, "match", { required: false });
        const match = matchRaw === "exact" || matchRaw === "prefix" ? matchRaw : "contains";
        const caseSensitive = typeof params.caseSensitive === "boolean" ? params.caseSensitive : false;
        const controlType = readStringParam(params, "controlType", { required: false });
        const maxResults = Math.min(25, readPositiveInt(params, "maxResults", 5));

        if (action === "find") {
          const matches = await resolveUiTextMatches({
            text,
            match,
            caseSensitive,
            controlType: controlType || undefined,
            maxResults,
          });
          return jsonResult({ matches });
        }

        if (action === "focus_text") {
          const resultIndex = readNonNegativeInt(params, "resultIndex", 0);
          const focusModeRaw = readStringParam(params, "focusMode", { required: false });
          const focusMode =
            focusModeRaw === "mouse" || focusModeRaw === "uia" || focusModeRaw === "auto"
              ? focusModeRaw
              : "auto";

          if (focusMode !== "mouse") {
            const focused = await tryFocusUiElement({
              text,
              match,
              caseSensitive,
              controlType: controlType || undefined,
              maxResults,
              resultIndex,
            });
            if (focused.success && focused.target) {
              focusTarget = focused.target;
              return jsonResult({ ok: true, mode: "uia", target: focused.target });
            }
          }

          const matches = await resolveUiTextMatches({
            text,
            match,
            caseSensitive,
            controlType: controlType || undefined,
            maxResults,
          });
          if (matches.length === 0) {
            throw new Error(`no UI element matches text: ${text}`);
          }
          if (resultIndex >= matches.length) {
            throw new Error(`resultIndex ${resultIndex} out of range (matches: ${matches.length})`);
          }
          const target = matches[resultIndex];
          if (typeof target?.x !== "number" || typeof target?.y !== "number") {
            throw new Error("matched UI element has no bounds");
          }
          const steps = readPositiveInt(params, "steps", 8);
          const stepDelayMs = readPositiveInt(params, "stepDelayMs", 5);
          const jitterPx = readNonNegativeInt(params, "jitterPx", 1);
          await runInputAction({
            action: "hover",
            args: { x: target.x, y: target.y, durationMs: 80, steps, stepDelayMs, jitterPx },
          });
          return jsonResult({ ok: true, mode: "mouse", target });
        }

        if (action === "set_value_text") {
          const value = readStringParam(params, "value", { required: true, allowEmpty: true });
          const resultIndex = readNonNegativeInt(params, "resultIndex", 0);
          const valueFallback = typeof params.valueFallback === "boolean" ? params.valueFallback : true;
          const focusModeRaw = readStringParam(params, "focusMode", { required: false });
          const focusMode =
            focusModeRaw === "mouse" || focusModeRaw === "uia" || focusModeRaw === "auto"
              ? focusModeRaw
              : "auto";
          setValueMeta = {
            text,
            value,
            match,
            caseSensitive,
            controlType: controlType || undefined,
            maxResults,
            resultIndex,
            focusMode,
            valueFallback,
          };
        }

        if (action === "click_text_uia") {
          const resultIndex = readNonNegativeInt(params, "resultIndex", 0);
          const matches = await resolveUiTextMatches({
            text,
            match,
            caseSensitive,
            controlType: controlType || undefined,
            maxResults,
          });
          if (matches.length === 0) {
            throw new Error(`no UI element matches text: ${text}`);
          }
          if (resultIndex >= matches.length) {
            throw new Error(`resultIndex ${resultIndex} out of range (matches: ${matches.length})`);
          }
          const target = matches[resultIndex];
          invokeTarget = target;
          invokeMeta = {
            text,
            match,
            caseSensitive,
            controlType: controlType || undefined,
            maxResults,
            resultIndex,
          };
          uiHit = {
            name: target.name ?? text,
            automationId: target.automationId,
            helpText: target.helpText,
            controlType: target.controlType,
          };
          approvalParams = {
            ...params,
            ...(typeof target?.x === "number" && typeof target?.y === "number" ? { x: target.x, y: target.y } : {}),
          };
        }

        if (action === "click_text") {
          const matches = await resolveUiTextMatches({
            text,
            match,
            caseSensitive,
            controlType: controlType || undefined,
            maxResults,
          });

          if (matches.length === 0) {
            throw new Error(`no UI element matches text: ${text}`);
          }

          const resultIndex = readNonNegativeInt(params, "resultIndex", 0);
          if (resultIndex >= matches.length) {
            throw new Error(`resultIndex ${resultIndex} out of range (matches: ${matches.length})`);
          }

          const target = matches[resultIndex];
          if (typeof target?.x !== "number" || typeof target?.y !== "number") {
            throw new Error("matched UI element has no bounds");
          }

          clickTextTarget = target;
          clickTextMeta = {
            text,
            match,
            caseSensitive,
            controlType: controlType || undefined,
            maxResults,
            resultIndex,
          };
          uiHit = {
            name: target.name ?? text,
            automationId: target.automationId,
            helpText: target.helpText,
            controlType: target.controlType,
          };
          approvalParams = { ...params, x: target.x, y: target.y };
        }
      }

      if (confirm === "dangerous" && action === "click" && !uiHit) {
        const buttonRaw = readStringParam(params, "button", { required: false });
        const button = buttonRaw === "right" || buttonRaw === "middle" ? buttonRaw : "left";
        const clicks = readPositiveInt(params, "clicks", 1);
        if (button === "left" && clicks === 1) {
          const x = Math.floor(requireNumber(params, "x"));
          const y = Math.floor(requireNumber(params, "y"));
          uiHit = await resolveUiHitTest({ x, y }).catch(() => null);
        }
      }

      if (
        shouldApproveAction({
          action,
          confirm,
          rawParams: approvalParams,
          uiHit,
          uiHitMatchers,
        })
      ) {
        let approvalText = formatApprovalCommand(`computer.${action}`, approvalParams);
        if ((action === "click" || action === "click_text" || action === "click_text_uia") && uiHit && uiHitMatchers) {
          if (isDangerousUiHit(uiHit, uiHitMatchers)) {
            const label = uiHit.name || uiHit.automationId || uiHit.controlType || "";
            if (label) {
              approvalText += ` target=${JSON.stringify(label.slice(0, 80))}`;
            }
          }
        }
        await ensureApproval({
          gatewayOpts,
          command: approvalText,
          timeoutMs: 120_000,
          allowAlwaysCache,
        });
      }

      const delayMs =
        typeof params.delayMs === "number" && Number.isFinite(params.delayMs)
          ? Math.max(0, Math.floor(params.delayMs))
          : undefined;

      if (action === "move") {
        const x = requireNumber(params, "x");
        const y = requireNumber(params, "y");
        const steps = readPositiveInt(params, "steps", 15);
        const stepDelayMs = readPositiveInt(params, "stepDelayMs", 5);
        const jitterPx = readNonNegativeInt(params, "jitterPx", 1);
        await runInputAction({ action: "move", args: { x, y, steps, stepDelayMs, jitterPx, delayMs } });
        if (agentDir) {
          await recordTeachStep({
            agentDir,
            sessionKey,
            action: "move",
            stepParams: { x, y, steps, stepDelayMs, jitterPx, delayMs },
          });
        }
        return jsonResult({ ok: true });
      }

      if (action === "set_value_text") {
        if (!setValueMeta) {
          throw new Error("set_value_text requires a text match");
        }
        const {
          text,
          value,
          match,
          caseSensitive,
          controlType,
          maxResults,
          resultIndex,
          focusMode,
          valueFallback,
        } = setValueMeta;

        const result = await trySetValueUiElement({
          text,
          value,
          match,
          caseSensitive,
          controlType,
          maxResults,
          resultIndex,
        });
        if (result.success) {
          if (agentDir) {
            await recordTeachStep({
              agentDir,
              sessionKey,
              action: "set_value_text",
              stepParams: {
                text,
                value,
                match,
                caseSensitive,
                controlType,
                resultIndex,
                maxResults,
                valueFallback,
                mode: "value",
              },
            });
          }
          return jsonResult({ ok: true, mode: "value", target: result.target });
        }

        if (!valueFallback) {
          const reason = result.reason ? ` (${result.reason})` : "";
          throw new Error(`set_value_text failed${reason}`);
        }

        const matches = await resolveUiTextMatches({
          text,
          match,
          caseSensitive,
          controlType: controlType || undefined,
          maxResults,
        });
        if (matches.length === 0) {
          throw new Error(`no UI element matches text: ${text}`);
        }
        if (resultIndex >= matches.length) {
          throw new Error(`resultIndex ${resultIndex} out of range (matches: ${matches.length})`);
        }

        const target = matches[resultIndex];
        if (typeof target?.x !== "number" || typeof target?.y !== "number") {
          throw new Error("matched UI element has no bounds");
        }

        if (focusMode !== "mouse") {
          const focused = await tryFocusUiElement({
            text,
            match,
            caseSensitive,
            controlType,
            maxResults,
            resultIndex,
          });
          if (!focused.success) {
            if (focusMode === "uia") {
              throw new Error("set_value_text fallback focus failed");
            }
          }
        }

        if (focusMode === "mouse" || focusMode === "auto") {
          const steps = readPositiveInt(params, "steps", 8);
          const stepDelayMs = readPositiveInt(params, "stepDelayMs", 5);
          const jitterPx = readNonNegativeInt(params, "jitterPx", 1);
          await runInputAction({
            action: "hover",
            args: { x: target.x, y: target.y, durationMs: 80, steps, stepDelayMs, jitterPx, delayMs },
          });
        }

        await runInputAction({ action: "hotkey", args: { key: "a", ctrl: true, delayMs } });
        if (value.length > 0) {
          await runInputAction({ action: "type", args: { text: value, delayMs } });
        } else {
          await runInputAction({ action: "press", args: { key: "backspace", delayMs } });
        }

        if (agentDir) {
          await recordTeachStep({
            agentDir,
            sessionKey,
            action: "set_value_text",
            stepParams: {
              text,
              value,
              match,
              caseSensitive,
              controlType,
              resultIndex,
              maxResults,
              valueFallback,
              mode: "type",
            },
          });
        }

        return jsonResult({ ok: true, mode: "type", target });
      }

      if (action === "click_text") {
        if (!clickTextTarget || !clickTextMeta) {
          throw new Error("click_text requires a text match");
        }
        const x = clickTextTarget.x ?? 0;
        const y = clickTextTarget.y ?? 0;
        const buttonRaw = readStringParam(params, "button", { required: false });
        const button = buttonRaw === "right" || buttonRaw === "middle" ? buttonRaw : "left";
        const clicks = readPositiveInt(params, "clicks", 1);
        const steps = readPositiveInt(params, "steps", 8);
        const stepDelayMs = readPositiveInt(params, "stepDelayMs", 5);
        const jitterPx = readNonNegativeInt(params, "jitterPx", 1);
        await runInputAction({
          action: "click",
          args: { x, y, button, clicks, steps, stepDelayMs, jitterPx, delayMs },
        });
        if (agentDir) {
          await recordTeachStep({
            agentDir,
            sessionKey,
            action: "click_text",
            stepParams: {
              text: clickTextMeta.text,
              match: clickTextMeta.match,
              caseSensitive: clickTextMeta.caseSensitive,
              controlType: clickTextMeta.controlType,
              resultIndex: clickTextMeta.resultIndex,
              maxResults: clickTextMeta.maxResults,
              x,
              y,
              button,
              clicks,
              steps,
              stepDelayMs,
              jitterPx,
              delayMs,
            },
          });
        }
        return jsonResult({
          ok: true,
          target: {
            name: clickTextTarget.name,
            automationId: clickTextTarget.automationId,
            controlType: clickTextTarget.controlType,
            x,
            y,
          },
        });
      }

      if (action === "click_text_uia") {
        if (!invokeMeta) {
          throw new Error("click_text_uia requires a text match");
        }
        const invokeFallback = typeof params.invokeFallback === "boolean" ? params.invokeFallback : true;
        const invokeResult = await tryInvokeUiElement({
          text: invokeMeta.text,
          match: invokeMeta.match,
          caseSensitive: invokeMeta.caseSensitive,
          controlType: invokeMeta.controlType,
          maxResults: invokeMeta.maxResults,
          resultIndex: invokeMeta.resultIndex,
        });
        if (invokeResult.success && invokeResult.target) {
          if (agentDir) {
            await recordTeachStep({
              agentDir,
              sessionKey,
              action: "click_text_uia",
              stepParams: {
                text: invokeMeta.text,
                match: invokeMeta.match,
                caseSensitive: invokeMeta.caseSensitive,
                controlType: invokeMeta.controlType,
                resultIndex: invokeMeta.resultIndex,
                maxResults: invokeMeta.maxResults,
                invokeFallback,
                mode: "invoke",
              },
            });
          }
          return jsonResult({ ok: true, mode: "invoke", target: invokeResult.target });
        }
        if (!invokeFallback) {
          const reason = invokeResult.reason ? ` (${invokeResult.reason})` : "";
          throw new Error(`click_text_uia failed${reason}`);
        }

        if (!invokeTarget || typeof invokeTarget.x !== "number" || typeof invokeTarget.y !== "number") {
          throw new Error("matched UI element has no bounds for fallback click");
        }

        const buttonRaw = readStringParam(params, "button", { required: false });
        const button = buttonRaw === "right" || buttonRaw === "middle" ? buttonRaw : "left";
        const clicks = readPositiveInt(params, "clicks", 1);
        const steps = readPositiveInt(params, "steps", 8);
        const stepDelayMs = readPositiveInt(params, "stepDelayMs", 5);
        const jitterPx = readNonNegativeInt(params, "jitterPx", 1);
        await runInputAction({
          action: "click",
          args: {
            x: invokeTarget.x,
            y: invokeTarget.y,
            button,
            clicks,
            steps,
            stepDelayMs,
            jitterPx,
            delayMs,
          },
        });
        if (agentDir) {
          await recordTeachStep({
            agentDir,
            sessionKey,
            action: "click_text_uia",
            stepParams: {
              text: invokeMeta.text,
              match: invokeMeta.match,
              caseSensitive: invokeMeta.caseSensitive,
              controlType: invokeMeta.controlType,
              resultIndex: invokeMeta.resultIndex,
              maxResults: invokeMeta.maxResults,
              invokeFallback,
              mode: "mouse",
              x: invokeTarget.x,
              y: invokeTarget.y,
              button,
              clicks,
              steps,
              stepDelayMs,
              jitterPx,
              delayMs,
            },
          });
        }
        return jsonResult({
          ok: true,
          mode: "mouse",
          target: {
            name: invokeTarget.name,
            automationId: invokeTarget.automationId,
            controlType: invokeTarget.controlType,
            x: invokeTarget.x,
            y: invokeTarget.y,
          },
        });
      }

      if (action === "click") {
        const x = requireNumber(params, "x");
        const y = requireNumber(params, "y");
        const buttonRaw = readStringParam(params, "button", { required: false });
        const button = buttonRaw === "right" || buttonRaw === "middle" ? buttonRaw : "left";
        const clicks = readPositiveInt(params, "clicks", 1);
        const steps = readPositiveInt(params, "steps", 8);
        const stepDelayMs = readPositiveInt(params, "stepDelayMs", 5);
        const jitterPx = readNonNegativeInt(params, "jitterPx", 1);
        await runInputAction({
          action: "click",
          args: { x, y, button, clicks, steps, stepDelayMs, jitterPx, delayMs },
        });
        if (agentDir) {
          await recordTeachStep({
            agentDir,
            sessionKey,
            action: "click",
            stepParams: { x, y, button, clicks, steps, stepDelayMs, jitterPx, delayMs },
          });
        }
        return jsonResult({ ok: true });
      }

      if (action === "dblclick") {
        const x = requireNumber(params, "x");
        const y = requireNumber(params, "y");
        await runInputAction({ action: "click", args: { x, y, button: "left", clicks: 2, delayMs } });
        if (agentDir) {
          await recordTeachStep({
            agentDir,
            sessionKey,
            action: "dblclick",
            stepParams: { x, y, delayMs },
          });
        }
        return jsonResult({ ok: true });
      }

      if (action === "right_click") {
        const x = requireNumber(params, "x");
        const y = requireNumber(params, "y");
        await runInputAction({ action: "click", args: { x, y, button: "right", clicks: 1, delayMs } });
        if (agentDir) {
          await recordTeachStep({
            agentDir,
            sessionKey,
            action: "right_click",
            stepParams: { x, y, delayMs },
          });
        }
        return jsonResult({ ok: true });
      }

      if (action === "mouse_down") {
        const buttonRaw = readStringParam(params, "button", { required: false });
        const button = buttonRaw === "right" || buttonRaw === "middle" ? buttonRaw : "left";
        const x = typeof params.x === "number" ? params.x : undefined;
        const y = typeof params.y === "number" ? params.y : undefined;
        const steps = readPositiveInt(params, "steps", 10);
        const stepDelayMs = readPositiveInt(params, "stepDelayMs", 6);
        const jitterPx = readNonNegativeInt(params, "jitterPx", 1);
        await runInputAction({
          action: "mouse_down",
          args: { ...(x !== undefined && y !== undefined ? { x, y, steps, stepDelayMs, jitterPx } : {}), button, delayMs },
        });
        if (agentDir) {
          await recordTeachStep({
            agentDir,
            sessionKey,
            action: "mouse_down",
            stepParams: {
              ...(x !== undefined && y !== undefined ? { x, y, steps, stepDelayMs, jitterPx } : {}),
              button,
              delayMs,
            },
          });
        }
        return jsonResult({ ok: true });
      }

      if (action === "mouse_up") {
        const buttonRaw = readStringParam(params, "button", { required: false });
        const button = buttonRaw === "right" || buttonRaw === "middle" ? buttonRaw : "left";
        const x = typeof params.x === "number" ? params.x : undefined;
        const y = typeof params.y === "number" ? params.y : undefined;
        const steps = readPositiveInt(params, "steps", 10);
        const stepDelayMs = readPositiveInt(params, "stepDelayMs", 6);
        const jitterPx = readNonNegativeInt(params, "jitterPx", 1);
        await runInputAction({
          action: "mouse_up",
          args: { ...(x !== undefined && y !== undefined ? { x, y, steps, stepDelayMs, jitterPx } : {}), button, delayMs },
        });
        if (agentDir) {
          await recordTeachStep({
            agentDir,
            sessionKey,
            action: "mouse_up",
            stepParams: {
              ...(x !== undefined && y !== undefined ? { x, y, steps, stepDelayMs, jitterPx } : {}),
              button,
              delayMs,
            },
          });
        }
        return jsonResult({ ok: true });
      }

      if (action === "mouse_hold") {
        const buttonRaw = readStringParam(params, "button", { required: false });
        const button = buttonRaw === "right" || buttonRaw === "middle" ? buttonRaw : "left";
        const x = typeof params.x === "number" ? params.x : undefined;
        const y = typeof params.y === "number" ? params.y : undefined;
        const durationMs = readPositiveInt(params, "durationMs", 250);
        const steps = readPositiveInt(params, "steps", 10);
        const stepDelayMs = readPositiveInt(params, "stepDelayMs", 6);
        const jitterPx = readNonNegativeInt(params, "jitterPx", 1);
        await runInputAction({
          action: "mouse_hold",
          args: {
            ...(x !== undefined && y !== undefined ? { x, y, steps, stepDelayMs, jitterPx } : {}),
            button,
            durationMs,
            delayMs,
          },
        });
        if (agentDir) {
          await recordTeachStep({
            agentDir,
            sessionKey,
            action: "mouse_hold",
            stepParams: {
              ...(x !== undefined && y !== undefined ? { x, y, steps, stepDelayMs, jitterPx } : {}),
              button,
              durationMs,
              delayMs,
            },
          });
        }
        return jsonResult({ ok: true });
      }

      if (action === "key_down") {
        const keyRaw = readStringParam(params, "key", { required: true });
        const key = normalizeKeyToken(keyRaw);
        await runInputAction({ action: "key_down", args: { key, delayMs } });
        if (agentDir) {
          await recordTeachStep({ agentDir, sessionKey, action: "key_down", stepParams: { key, delayMs } });
        }
        return jsonResult({ ok: true });
      }

      if (action === "key_up") {
        const keyRaw = readStringParam(params, "key", { required: true });
        const key = normalizeKeyToken(keyRaw);
        await runInputAction({ action: "key_up", args: { key, delayMs } });
        if (agentDir) {
          await recordTeachStep({ agentDir, sessionKey, action: "key_up", stepParams: { key, delayMs } });
        }
        return jsonResult({ ok: true });
      }

      if (action === "key_hold") {
        const keyRaw = readStringParam(params, "key", { required: true });
        const key = normalizeKeyToken(keyRaw);
        const durationMs = readPositiveInt(params, "durationMs", 250);
        await runInputAction({ action: "key_hold", args: { key, durationMs, delayMs } });
        if (agentDir) {
          await recordTeachStep({
            agentDir,
            sessionKey,
            action: "key_hold",
            stepParams: { key, durationMs, delayMs },
          });
        }
        return jsonResult({ ok: true });
      }

      if (action === "scroll") {
        const deltaY = requireNumber(params, "deltaY");
        const x = typeof params.x === "number" ? params.x : undefined;
        const y = typeof params.y === "number" ? params.y : undefined;
        const steps = readPositiveInt(params, "steps", 8);
        const stepDelayMs = readPositiveInt(params, "stepDelayMs", 5);
        const jitterPx = readNonNegativeInt(params, "jitterPx", 1);
        await runInputAction({
          action: "scroll",
          args: {
            ...(x !== undefined && y !== undefined ? { x, y, steps, stepDelayMs, jitterPx } : {}),
            deltaY,
            delayMs,
          },
        });
        if (agentDir) {
          await recordTeachStep({
            agentDir,
            sessionKey,
            action: "scroll",
            stepParams: {
              ...(x !== undefined && y !== undefined ? { x, y, steps, stepDelayMs, jitterPx } : {}),
              deltaY,
              delayMs,
            },
          });
        }
        return jsonResult({ ok: true });
      }

      if (action === "drag") {
        const x = requireNumber(params, "x");
        const y = requireNumber(params, "y");
        const x2 = requireNumber(params, "x2");
        const y2 = requireNumber(params, "y2");
        const steps = readPositiveInt(params, "steps", 25);
        const stepDelayMs = readPositiveInt(params, "stepDelayMs", 10);
        const jitterPx = readNonNegativeInt(params, "jitterPx", 1);
        await runInputAction({
          action: "drag",
          args: { x, y, x2, y2, steps, stepDelayMs, jitterPx, delayMs },
        });
        if (agentDir) {
          await recordTeachStep({
            agentDir,
            sessionKey,
            action: "drag",
            stepParams: { x, y, x2, y2, steps, stepDelayMs, jitterPx, delayMs },
          });
        }
        return jsonResult({ ok: true });
      }

      if (action === "type") {
        const text = readStringParam(params, "text", { required: true, allowEmpty: true });
        await runInputAction({ action: "type", args: { text, delayMs } });
        if (agentDir) {
          await recordTeachStep({ agentDir, sessionKey, action: "type", stepParams: { text, delayMs } });
        }
        return jsonResult({ ok: true });
      }

      if (action === "hotkey") {
        const keyRaw = readStringParam(params, "key", { required: true });
        const key = normalizeKeyToken(keyRaw);
        const ctrl = typeof params.ctrl === "boolean" ? params.ctrl : false;
        const alt = typeof params.alt === "boolean" ? params.alt : false;
        const shift = typeof params.shift === "boolean" ? params.shift : false;
        const meta = typeof params.meta === "boolean" ? params.meta : false;
        await runInputAction({ action: "hotkey", args: { key, ctrl, alt, shift, meta, delayMs } });
        if (agentDir) {
          await recordTeachStep({
            agentDir,
            sessionKey,
            action: "hotkey",
            stepParams: { key, ctrl, alt, shift, meta, delayMs },
          });
        }
        return jsonResult({ ok: true });
      }

      if (action === "press") {
        const keyRaw = readStringParam(params, "key", { required: true });
        const key = normalizeKeyToken(keyRaw);
        await runInputAction({ action: "press", args: { key, delayMs } });
        if (agentDir) {
          await recordTeachStep({ agentDir, sessionKey, action: "press", stepParams: { key, delayMs } });
        }
        return jsonResult({ ok: true });
      }

      throw new Error(`unsupported computer action: ${String(action)}`);
    },
  };
}
