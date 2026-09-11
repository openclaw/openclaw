// Shared harness for the two Codex native hook relay live proof lanes:
// `gateway-codex-harness.native-hook-relay-proof.live.test.ts` (the five static
// configuration modes) and
// `gateway-codex-harness.native-hook-relay-proof-transition.live.test.ts` (the
// existing-session flip). Standing up one real gateway against one real Codex
// app-server is the same work for both, so it lives here and each lane owns only
// its own expectations.
//
// Opt-in (both lanes):
//   OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CODEX_RELAY_PROOF=1 \
//   RELAY_PROOF_MODE=<baseline|disabled-never|disabled-active
//                     |approval-baseline|approval-disabled|transition> \
//   RELAY_PROOF_DIR=<abs dir> RELAY_PROOF_CODEX_COMMAND=<abs tee shim> \
//   [RELAY_PROOF_APPROVAL_COMMAND=<shell command template with {token}>] \
//   pnpm exec vitest run --config test/vitest/vitest.live.config.ts \
//     src/gateway/test/gateway-codex-harness.native-hook-relay-proof.live.test.ts \
//     src/gateway/test/gateway-codex-harness.native-hook-relay-proof-transition.live.test.ts
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "vitest";
import type { EventFrame } from "../../../packages/gateway-protocol/src/index.js";
import { isLiveTestEnabled } from "../../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { setTestEnvValue } from "../../test-utils/env.js";
import type { GatewayClient } from "../client.js";
import {
  connectTestGatewayClient,
  ensurePairedTestGatewayClientIdentity,
} from "../gateway-cli-backend.live-helpers.js";
import { restoreLiveEnv, snapshotLiveEnv, type LiveEnvSnapshot } from "../live-env-test-helpers.js";

/**
 * True when this run opted into the relay proof and the configured mode belongs
 * to `modes`. An unset or unknown `RELAY_PROOF_MODE` enables every lane on
 * purpose, so an opted-in run fails loudly on `resolveRelayProofMode()` instead
 * of passing as an empty suite.
 */
export function isRelayProofLaneEnabled(modes: readonly RelayProofMode[]): boolean {
  if (!isLiveTestEnabled() || !isTruthyEnvValue(process.env.OPENCLAW_LIVE_CODEX_RELAY_PROOF)) {
    return false;
  }
  const raw = process.env.RELAY_PROOF_MODE?.trim();
  if (!raw || !RELAY_PROOF_MODES.includes(raw as RelayProofMode)) {
    return true;
  }
  return modes.includes(raw as RelayProofMode);
}

// `gpt-5.5` is no longer served by the ChatGPT Codex backend: every turn fails with
// `404 ... The model \`gpt-5.5\` does not exist or you do not have access to it`,
// which the app-server burns ~6 minutes of reconnect backoff on (5 WebSocket
// retries, an HTTPS transport fallback, 5 more retries) before failing the turn.
// Override with RELAY_PROOF_MODEL to record the pack on a different model.
const MODEL_KEY = process.env.RELAY_PROOF_MODEL ?? "openai/gpt-5.6-terra";
const THINKING = "low" as const;
// Sized against real backend latency, not a guess: a single relay-proof turn has
// been observed near 200s, so 180s aborted slow-but-healthy turns mid-flight and
// the gateway reported `CLIENT_TIMEOUT` for `agent` while the capture showed a
// complete `turn/start` → `turn/interrupt` sequence.
export const REQUEST_TIMEOUT_MS = 420_000;
// Stays below the gateway request timeout so the agent surfaces its own timeout
// as a normal reply instead of the transport aborting the turn first.
const AGENT_TIMEOUT_SECONDS = Math.max(1, Math.ceil(REQUEST_TIMEOUT_MS / 1000) - 10);
const GATEWAY_CONNECT_TIMEOUT_MS = 60_000;
// The widest mode (`baseline`/`disabled-*`) issues three sequential requests: the
// `/model` chat command plus two full agent turns, each bounded by
// REQUEST_TIMEOUT_MS. Budget 2 × 420s of model time, the connect handshake and the
// post-turn capture polls, and leave headroom on top.
export const TEST_TIMEOUT_MS = 1_800_000;

export type RelayProofMode =
  | "baseline"
  | "disabled-never"
  | "disabled-active"
  | "approval-baseline"
  | "approval-disabled"
  | "transition";

const RELAY_PROOF_MODES: readonly RelayProofMode[] = [
  "baseline",
  "disabled-never",
  "disabled-active",
  "approval-baseline",
  "approval-disabled",
  "transition",
];

/** Modes that prove the approval round-trip instead of the echo + `/btw` pair. */
const RELAY_PROOF_APPROVAL_MODES = new Set<RelayProofMode>([
  "approval-baseline",
  "approval-disabled",
]);

/** The agent entry every mode runs on; also the `agents/<id>/agent` state dir. */
const RELAY_PROOF_AGENT_ID = "dev";

/** Poll interval for every capture file these lanes wait on. */
export const CAPTURE_POLL_MS = 250;

// The tee appends synchronously, so the frame is normally already on disk.
export const CAPTURE_FRAME_TIMEOUT_MS = 15_000;

export function resolveRelayProofMode(): RelayProofMode {
  const raw = process.env.RELAY_PROOF_MODE?.trim();
  if (!raw || !RELAY_PROOF_MODES.includes(raw as RelayProofMode)) {
    throw new Error(`RELAY_PROOF_MODE must be one of ${RELAY_PROOF_MODES.join(", ")}; got ${raw}`);
  }
  return raw as RelayProofMode;
}

export function isRelayProofApprovalMode(mode: RelayProofMode): boolean {
  return RELAY_PROOF_APPROVAL_MODES.has(mode);
}

/** The operator-authored relay value for one run or phase; `undefined` omits the key. */
export type RelayProofTransitionRelayConfig = { enabled: boolean } | undefined;

/**
 * The five configurations under proof. `mode` fixes the effective approval policy
 * so approvals are genuinely active on the wire, independent of the configured
 * value the parse-layer guard reads: `guardian` resolves to a prompting policy,
 * while the documented full kill-switch case pins `approvalPolicy: "never"`
 * explicitly — the only spelling that unlocks it. The `approval-*` pair pins
 * `on-request` so a non-trusted command deterministically raises
 * `item/commandExecution/requestApproval` rather than relying on the model to
 * escalate on its own.
 *
 * `on-request` is the modern operator spelling of that prompting policy:
 * `approvalPolicy: "untrusted"` is retired, and `readCodexPluginConfig` now throws
 * the migration error `…approvalPolicy="untrusted" is retired; run "openclaw
 * doctor --fix" to migrate it to "on-request"` before the schema is even parsed,
 * so the plugin config fails at startup and no app-server ever spawns. The
 * `codexAppServerApprovalPolicySchema` enum is `["never", "on-request"]` (with
 * `on-failure` preprocessed to `on-request`). `mode: "guardian"` is untouched by
 * that retirement — it is a separate `["yolo", "guardian"]` policy mode, and it
 * already *implies* `on-request` when no explicit policy is set
 * (`config-options.ts`: `policyMode === "guardian" ? "on-request" : "never"`).
 * Spelling it out keeps `approvalPolicySource: "config"` for these two modes, so
 * the prompting policy is pinned by the proof rather than inherited implicitly.
 *
 * The `approval-*` pair also pins `approvalsReviewer: "user"`, which is what makes
 * the round-trip observable rather than merely happening. `guardian` on its own
 * lands on the model-backed `"auto_review"` reviewer — `config-options.ts` ends
 * with `approvalsReviewer: … ?? (policyMode === "guardian" ? "auto_review" :
 * "user")` — and that reviewer resolves the escalation inside the app-server, so
 * no `item/commandExecution/requestApproval` is ever sent to the client. `"user"`
 * needs no other wiring: `codexAppServerApprovalsReviewerSchema` accepts it at
 * `plugins.entries.codex.config.appServer.approvalsReviewer`, and it also flips
 * `forceUserReviewerForUnknownModel` off (that guard fires only when an explicit
 * `guardian` is paired with `explicitApprovalsReviewer !== "user"`), so
 * `forcedPolicy` stays undefined and the explicit value reaches `turn-params.ts`
 * verbatim instead of being rewritten by the forced-policy branch.
 */
const RELAY_PROOF_APP_SERVER_CONFIGS = {
  baseline: { mode: "guardian" },
  "disabled-never": { mode: "yolo", approvalPolicy: "never", nativeHookRelay: { enabled: false } },
  "disabled-active": { mode: "guardian", nativeHookRelay: { enabled: false } },
  "approval-baseline": {
    mode: "guardian",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
  },
  "approval-disabled": {
    mode: "guardian",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    nativeHookRelay: { enabled: false },
  },
  // The transition lane owns its own `nativeHookRelay` value per phase (see
  // RELAY_PROOF_TRANSITION_PHASES); this is only the shared policy floor. It is
  // the `disabled-never` policy shape on purpose: the mid-session flip must be
  // able to reach the *full* opt-out, which needs an effective `"never"` policy
  // and no OpenClaw before-tool policy.
  transition: { mode: "yolo", approvalPolicy: "never" },
} as const satisfies Record<RelayProofMode, Record<string, unknown>>;

function buildModeAppServerConfig(
  mode: RelayProofMode,
  relayOverride?: RelayProofTransitionRelayConfig,
): Record<string, unknown> {
  const base = RELAY_PROOF_APP_SERVER_CONFIGS[mode];
  return relayOverride === undefined ? base : { ...base, nativeHookRelay: relayOverride };
}

async function getFreeGatewayPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (port <= 0) {
    throw new Error("failed to allocate gateway port");
  }
  return port;
}

async function createLiveWorkspace(tempDir: string): Promise<string> {
  const workspace = path.join(tempDir, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, "AGENTS.md"),
    [
      "# AGENTS.md",
      "",
      "Follow exact reply instructions from the user.",
      "Do not add commentary when asked for an exact response.",
    ].join("\n"),
  );
  return workspace;
}

async function removeLiveTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EACCES") {
        throw error;
      }
      await delay(100);
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
}

async function writeProofGatewayConfig(params: {
  codexCommand: string;
  configPath: string;
  mode: RelayProofMode;
  port: number;
  relayOverride?: RelayProofTransitionRelayConfig;
  token: string;
  workspace: string;
}): Promise<Record<string, unknown>> {
  const appServer = {
    command: params.codexCommand,
    ...buildModeAppServerConfig(params.mode, params.relayOverride),
  };
  const cfg: OpenClawConfig = {
    gateway: {
      mode: "local",
      port: params.port,
      auth: { mode: "token", token: params.token },
    },
    // Loop detection is explicit opt-in: `nativePreToolUseMayRunLoopDetection`
    // requires `enabled === true`, not merely "not disabled". Without this the
    // proof gateway has no OpenClaw-side pre-tool work at all, `shouldRelayEvent`
    // writes `hooks.PreToolUse: []`, and every "installed" expectation below
    // collapses to "empty". It also arms the managed-only hook attestation, which
    // `nativeHookRelayRequired` gates on the same predicate.
    //
    // Deliberately loop detection and NOT a `before_tool_call` plugin hook: a
    // global before-tool policy would make `hasBeforeToolCallPolicy()` true for
    // every mode, so `disabled-never` would be narrowed instead of honored and the
    // lane would stop proving the documented full kill-switch.
    tools: { loopDetection: { enabled: true } },
    plugins: {
      allow: ["codex"],
      entries: {
        codex: {
          enabled: true,
          config: { appServer },
        },
      },
    },
    agents: {
      defaults: {
        workspace: params.workspace,
        skipBootstrap: true,
        timeoutSeconds: AGENT_TIMEOUT_SECONDS,
        maxConcurrent: 4,
        thinkingDefault: THINKING,
        model: { primary: MODEL_KEY },
        models: { [MODEL_KEY]: { agentRuntime: { id: "codex" } } },
        sandbox: { mode: "off" },
      },
      entries: {
        dev: {
          default: true,
          workspace: params.workspace,
          thinkingDefault: THINKING,
          model: { primary: MODEL_KEY },
          models: { [MODEL_KEY]: { agentRuntime: { id: "codex" } } },
        },
      },
    },
  } as OpenClawConfig;
  await fs.writeFile(params.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  return appServer;
}

type CapturedAgentEvent = {
  stream: string;
  data?: Record<string, unknown>;
  sessionKey?: string;
};

export async function requestAgentTextWithEvents(params: {
  client: GatewayClient;
  message: string;
  sessionKey: string;
}): Promise<{ text: string; events: CapturedAgentEvent[] }> {
  const { extractPayloadText } = await import("../test-helpers.agent-results.js");
  const { onAgentEvent } = await import("../../infra/agent-events.js");
  const events: CapturedAgentEvent[] = [];
  const unsubscribe = onAgentEvent((event) => {
    if (!event.stream.startsWith("codex_app_server.")) {
      return;
    }
    events.push({ stream: event.stream, sessionKey: event.sessionKey, data: event.data });
  });
  try {
    const payload = await params.client.request(
      "agent",
      {
        sessionKey: params.sessionKey,
        idempotencyKey: `idem-${randomUUID()}-relay-proof`,
        message: params.message,
        deliver: false,
        thinking: THINKING,
        timeout: AGENT_TIMEOUT_SECONDS,
      },
      { expectFinal: true, timeoutMs: REQUEST_TIMEOUT_MS },
    );
    if (payload?.status !== "ok") {
      throw new Error(`agent status=${String(payload?.status)} payload=${JSON.stringify(payload)}`);
    }
    return { text: extractPayloadText(payload.result), events };
  } finally {
    unsubscribe();
  }
}

export function extractChatFinalText(event: EventFrame, runId: string): string | undefined {
  if (event.event !== "chat") {
    return undefined;
  }
  const payload = event.payload;
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (record.runId !== runId || record.state !== "final") {
    return undefined;
  }
  const message = record.message;
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const messageRecord = message as Record<string, unknown>;
  if (typeof messageRecord.text === "string" && messageRecord.text.trim()) {
    return messageRecord.text;
  }
  const content = Array.isArray(messageRecord.content) ? messageRecord.content : [];
  return content
    .map((entry) =>
      entry && typeof entry === "object" ? (entry as Record<string, unknown>).text : undefined,
    )
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .join("\n")
    .trim();
}

async function waitForChatFinalText(params: {
  events: EventFrame[];
  runId: string;
  timeoutMs: number;
}): Promise<string> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const text = params.events
      .map((event) => extractChatFinalText(event, params.runId))
      .find(Boolean);
    if (text) {
      return text;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for chat final for ${params.runId}`);
}

async function requestChatCommandText(params: {
  client: GatewayClient;
  command: string;
  events: EventFrame[];
  sessionKey: string;
}): Promise<string> {
  const runId = `idem-${randomUUID()}-relay-proof-cmd`;
  const started = await params.client.request(
    "chat.send",
    {
      sessionKey: params.sessionKey,
      idempotencyKey: runId,
      message: params.command,
    },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
  if (started?.status !== "started") {
    throw new Error(`command ${params.command} did not start: ${JSON.stringify(started)}`);
  }
  return await waitForChatFinalText({
    events: params.events,
    runId,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
}

export function readLifecycleIdentity(events: CapturedAgentEvent[]): {
  action?: string;
  clientId?: string;
  model?: string;
  threadId?: string;
} {
  const turnStarting = events.find(
    (event) =>
      event.stream === "codex_app_server.lifecycle" && event.data?.phase === "turn_starting",
  );
  const threadReady = events.find(
    (event) =>
      event.stream === "codex_app_server.lifecycle" && event.data?.phase === "thread_ready",
  );
  return {
    action: threadReady?.data?.action as string | undefined,
    clientId: threadReady?.data?.clientId as string | undefined,
    model: turnStarting?.data?.model as string | undefined,
    threadId: threadReady?.data?.threadId as string | undefined,
  };
}

/**
 * The overlay vocabulary both lanes assert in. Two asymmetries are baked in:
 *  - `thread/start` is built with `clearOmittedEvents` off, so an event the
 *    resolver did not select emits **no key at all** ("absent"). `thread/fork`
 *    and `thread/resume` are built with it on, so every key is present and
 *    omitted ones are `[]`.
 *  - "selected" is not "installed": `shouldRelayEvent` writes `[]` for a
 *    selected event with no OpenClaw-side work. The proof gateway registers no
 *    before-tool policy and no after_tool_call/before_agent_finalize hooks, so
 *    `post_tool_use`/`before_agent_finalize` are selected-but-empty, while
 *    `pre_tool_use` installs via the loop detector that `writeProofGatewayConfig`
 *    turns on explicitly (`tools.loopDetection.enabled`).
 */
type CodexHookOverlayState = "installed" | "empty" | "absent";
type CodexHookKey = (typeof RELAY_PROOF_HOOK_KEYS)[number];
export type CodexHookOverlay = {
  /** `"absent"` pins that the overlay does not carry the key at all. */
  featuresHooks: boolean | "absent";
  hooks: Record<CodexHookKey, CodexHookOverlayState>;
  /** `hooks.state` keys that must be present and disabled. */
  hookStateDisabled?: readonly string[];
};

const RELAY_PROOF_HOOK_KEYS = [
  "hooks.PreToolUse",
  "hooks.PostToolUse",
  "hooks.PermissionRequest",
  "hooks.Stop",
] as const;

/**
 * The only source paths OpenClaw may address in `hooks.state`. Codex keys hook
 * state by the source path of the layer that declared the hook, so restricting
 * every key to these two spellings of its own session-flags layer is what makes
 * the opt-out unable to reach a hook it did not install.
 */
export const RELAY_PROOF_SESSION_FLAGS_STATE_KEY_PREFIXES = [
  "/<session-flags>/config.toml:",
  "<session-flags>/config.toml:",
] as const;

/**
 * The exact OpenClaw session-layer hook command keys. The relay opt-out pins
 * these disabled so lower-precedence copies of the injected commands cannot be
 * layered back in during Codex hook discovery.
 */
export const RELAY_PROOF_OPT_OUT_HOOK_STATE_KEYS = [
  "/<session-flags>/config.toml:pre_tool_use:0:0",
  "<session-flags>/config.toml:pre_tool_use:0:0",
  "/<session-flags>/config.toml:post_tool_use:0:0",
  "<session-flags>/config.toml:post_tool_use:0:0",
  "/<session-flags>/config.toml:permission_request:0:0",
  "<session-flags>/config.toml:permission_request:0:0",
  "/<session-flags>/config.toml:stop:0:0",
  "<session-flags>/config.toml:stop:0:0",
] as const;

/**
 * The three request methods that carry a full `params.config` to the app-server.
 * Everything the transition lane asserts is one of these frames.
 */
export type CodexThreadLifecycleMethod = "thread/start" | "thread/resume" | "thread/fork";

function classifyCodexHookOverlayEntry(
  config: Record<string, unknown>,
  key: string,
): { state: CodexHookOverlayState | "other"; raw: unknown } {
  if (!(key in config)) {
    return { state: "absent", raw: undefined };
  }
  const raw = config[key];
  if (!Array.isArray(raw)) {
    return { state: "other", raw };
  }
  return { state: raw.length === 0 ? "empty" : "installed", raw };
}

export /** Asserts one already-read `params.config` against an expected overlay. */
function assertCodexHookOverlay(params: {
  config: Record<string, unknown>;
  expected: CodexHookOverlay;
  label: string;
  method: string;
}): void {
  const config = params.config;
  if (params.expected.featuresHooks === "absent") {
    expect(
      Object.hasOwn(config, "features.hooks"),
      `${params.label}: features.hooks must stay untouched on ${params.method} (captured ${JSON.stringify(
        config["features.hooks"],
      )})`,
    ).toBe(false);
  } else {
    expect(
      config["features.hooks"],
      `${params.label}: features.hooks on ${params.method} (captured ${JSON.stringify(
        config["features.hooks"],
      )})`,
    ).toBe(params.expected.featuresHooks);
  }
  for (const key of RELAY_PROOF_HOOK_KEYS) {
    const { state, raw } = classifyCodexHookOverlayEntry(config, key);
    expect(
      state,
      `${params.label}: ${key} on ${params.method} (captured ${JSON.stringify(raw)})`,
    ).toBe(params.expected.hooks[key]);
  }
  const rawHookState = config["hooks.state"];
  const hookState =
    rawHookState && typeof rawHookState === "object"
      ? (rawHookState as Record<string, unknown>)
      : undefined;
  for (const stateKey of params.expected.hookStateDisabled ?? []) {
    expect(
      hookState?.[stateKey],
      `${params.label}: hooks.state[${JSON.stringify(stateKey)}] on ${params.method} (captured ${JSON.stringify(
        rawHookState,
      )})`,
    ).toEqual({ enabled: false });
  }
}

export async function readCapturedJsonRpcRecords(
  capturePath: string,
): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = await fs.readFile(capturePath, "utf8");
  } catch {
    return [];
  }
  const records: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch {
      /* partial line */
    }
  }
  return records;
}

/** One prepared proof run: a live gateway, a paired client and the capture dir. */
export type RelayProofLane = {
  appServerConfig: Record<string, unknown>;
  client: GatewayClient;
  /** Every gateway event frame seen so far, in arrival order. */
  events: EventFrame[];
  mode: RelayProofMode;
  proofDir: string;
  /** Written to `receipt.json` when the lane finishes, however it finishes. */
  receipt: Record<string, unknown>;
  sessionKey: string;
  upperMode: string;
  /**
   * Rewrites the operator-authored `openclaw.json` with a different relay value
   * and returns the codex `appServer` config it wrote. Only the relay key
   * changes; every other value is the one this run started with.
   */
  writeOperatorRelayConfig: (
    relay: RelayProofTransitionRelayConfig,
  ) => Promise<Record<string, unknown>>;
};

/**
 * Stands the whole lane up — operator config, gateway, paired client, runtime
 * model pin — runs `body` against it, then tears it down. The receipt is written
 * in `finally`, so a failing lane still leaves its evidence behind.
 *
 * `prepare` runs after the operator config exists and before any app-server can
 * start, which is the only window in which a Codex config layer can be seeded for
 * the whole run.
 */
export async function runCodexRelayProofLane(params: {
  mode: RelayProofMode;
  prepare?: (context: { agentDir: string; proofDir: string }) => Promise<void>;
  body: (lane: RelayProofLane) => Promise<void>;
}): Promise<void> {
  const mode = params.mode;
  const proofDir = process.env.RELAY_PROOF_DIR?.trim();
  const codexCommand = process.env.RELAY_PROOF_CODEX_COMMAND?.trim();
  if (!proofDir) {
    throw new Error("RELAY_PROOF_DIR is required");
  }
  if (!codexCommand) {
    throw new Error("RELAY_PROOF_CODEX_COMMAND is required");
  }
  await fs.mkdir(proofDir, { recursive: true });

  const { clearRuntimeConfigSnapshot, loadConfig } = await import("../../config/config.js");
  const { resolveAgentDir } = await import("../../agents/agent-scope.js");
  const { startGatewayServer } = await import("../server.js");

  const previousEnv: LiveEnvSnapshot = snapshotLiveEnv(["OPENCLAW_ALLOW_SLOW_REPLY_TESTS"]);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-proof-"));
  const stateDir = path.join(tempDir, "state");
  const workspace = await createLiveWorkspace(tempDir);
  const configPath = path.join(tempDir, "openclaw.json");
  const token = `test-${randomUUID()}`;
  const port = await getFreeGatewayPort();

  clearRuntimeConfigSnapshot();
  process.env.OPENCLAW_AGENT_RUNTIME = "codex";
  // Codex-auth (ChatGPT) lane: never let stray OpenAI overrides hijack it.
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
  setTestEnvValue("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
  process.env.OPENCLAW_GATEWAY_TOKEN = token;
  process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
  process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

  await fs.mkdir(stateDir, { recursive: true });
  const writeOperatorRelayConfig = (relay: RelayProofTransitionRelayConfig) =>
    writeProofGatewayConfig({
      codexCommand,
      configPath,
      mode,
      port,
      ...(relay ? { relayOverride: relay } : {}),
      token,
      workspace,
    });
  const appServerConfig = await writeOperatorRelayConfig(undefined);
  if (params.prepare) {
    await params.prepare({
      agentDir: resolveAgentDir(loadConfig({ pin: false }), RELAY_PROOF_AGENT_ID),
      proofDir,
    });
  }
  const deviceIdentity = await ensurePairedTestGatewayClientIdentity({
    displayName: "vitest-codex-relay-proof",
  });
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let client: Awaited<ReturnType<typeof connectTestGatewayClient>> | undefined;
  const gatewayEvents: EventFrame[] = [];
  const receipt: Record<string, unknown> = {
    mode,
    modelKey: MODEL_KEY,
    pluginAppServerConfig: appServerConfig,
    startedAt: new Date().toISOString(),
  };

  try {
    server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
    });
    client = await connectTestGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      deviceIdentity,
      timeoutMs: GATEWAY_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      clientDisplayName: "vitest-codex-relay-proof",
      onEvent: (event) => {
        gatewayEvents.push(event);
      },
    });
    const activeClient = client;
    const sessionKey = `agent:${RELAY_PROOF_AGENT_ID}:relay-proof-${mode}`;

    const modelCommandText = await requestChatCommandText({
      client: activeClient,
      events: gatewayEvents,
      sessionKey,
      command: `/model ${MODEL_KEY} --runtime codex`,
    });
    receipt.modelCommandText = modelCommandText;
    expect(modelCommandText).toContain("Runtime set to codex");

    await params.body({
      appServerConfig,
      client: activeClient,
      events: gatewayEvents,
      mode,
      proofDir,
      receipt,
      sessionKey,
      upperMode: mode.toUpperCase(),
      writeOperatorRelayConfig,
    });
    receipt.finishedAt = new Date().toISOString();
  } finally {
    try {
      await fs.writeFile(
        path.join(proofDir, "receipt.json"),
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
    } catch {
      /* receipt is best-effort */
    }
    try {
      clearRuntimeConfigSnapshot();
      try {
        await client?.stopAndWait();
      } finally {
        await server?.close();
      }
      const { resetTaskFlowRegistryForTests, resetTaskRegistryForTests } =
        await import("../../tasks/task-runtime.test-helpers.js");
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    } finally {
      restoreLiveEnv(previousEnv);
      await removeLiveTempDir(tempDir);
    }
  }
}
