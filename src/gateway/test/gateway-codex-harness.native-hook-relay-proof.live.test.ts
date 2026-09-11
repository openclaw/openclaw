// Live proof lane for `resolveCodexAppServerNativeHookRelay`: drives a real
// Codex app-server through the in-process gateway and captures the exact
// `thread/start` (attempt) and `thread/fork` (side question) config the
// app-server receives for one configuration mode per run.
//
// The `approval-*` modes additionally capture a real
// `item/commandExecution/requestApproval` round-trip, proving an active approval
// policy still enforces while `nativeHookRelay.enabled: false` is configured.
//
// The existing-session `transition` mode is proved by the sibling lane in
// `gateway-codex-harness.native-hook-relay-proof-transition.live.test.ts`; the
// shared harness (gateway, capture directory, overlay assertions) lives in
// `gateway-codex-harness.native-hook-relay-proof.test-helpers.ts`, which also
// documents the opt-in environment.
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { EventFrame } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../client.js";
import {
  assertCodexHookOverlay,
  CAPTURE_FRAME_TIMEOUT_MS,
  CAPTURE_POLL_MS,
  type CodexHookOverlay,
  type CodexThreadLifecycleMethod,
  extractChatFinalText,
  isRelayProofApprovalMode,
  isRelayProofLaneEnabled,
  readCapturedJsonRpcRecords,
  readLifecycleIdentity,
  RELAY_PROOF_OPT_OUT_HOOK_STATE_KEYS,
  type RelayProofMode,
  REQUEST_TIMEOUT_MS,
  requestAgentTextWithEvents,
  resolveRelayProofMode,
  runCodexRelayProofLane,
  TEST_TIMEOUT_MS,
} from "./gateway-codex-harness.native-hook-relay-proof.test-helpers.js";

/** Every mode whose whole configuration is fixed before the gateway starts. */
type StaticRelayProofMode = Exclude<RelayProofMode, "transition">;

const describeLive = isRelayProofLaneEnabled([
  "baseline",
  "disabled-never",
  "disabled-active",
  "approval-baseline",
  "approval-disabled",
])
  ? describe
  : describe.skip;

const CODEX_APPROVAL_REQUEST_METHOD = "item/commandExecution/requestApproval";
// What raises an approval changed with the `untrusted` retirement. Under the old
// policy the safe-command classifier decided the approval on command *content*, so
// an opaque command was enough — a bare `echo` was auto-trusted, a `perl -e`
// one-liner was not. Under `on-request` no command content raises an approval on
// its own: the model does, by asking for the escalated sandbox permission on the
// shell call (`sandbox_permissions: "require_escalated"`). So the proof asks for
// the escalation explicitly and keeps the command itself side-effect-free — it
// only prints a nonce, and never has to defeat the sandbox to be interesting.
//
// The reason earlier runs saw no frame was the *reviewer*, not the command: an
// explicit `mode: "guardian"` without `approvalsReviewer` resolves to
// `"auto_review"` (`config-options.ts`), and that reviewer runs inside the
// app-server, so the escalation is answered in-process and never crosses the
// wire. A live capture showed exactly that shape — the shell call carried
// `sandbox_permissions: "require_escalated"` and the app-server emitted
// `guardianWarning: "Automatic approval review approved (risk: low …)"` with no
// JSON-RPC request at all. Pinning `approvalsReviewer: "user"` on the two
// `approval-*` modes is what routes the same escalation out to the client.
const DEFAULT_RELAY_PROOF_APPROVAL_COMMAND = "perl -e 'print \"{token}\\n\"'";
const APPROVAL_CAPTURE_TIMEOUT_MS = 60_000;

function resolveApprovalCommand(echoToken: string): string {
  const template =
    process.env.RELAY_PROOF_APPROVAL_COMMAND?.trim() || DEFAULT_RELAY_PROOF_APPROVAL_COMMAND;
  return template.replaceAll("{token}", echoToken);
}

/** Narrows to the modes this lane owns; the sibling lane owns `transition`. */
function resolveStaticRelayProofMode(): StaticRelayProofMode {
  const mode = resolveRelayProofMode();
  if (mode === "transition") {
    throw new Error(
      "RELAY_PROOF_MODE=transition belongs to gateway-codex-harness.native-hook-relay-proof-transition.live.test.ts",
    );
  }
  return mode;
}

/**
 * Reads a `chat.side_result` frame for this run. `/btw` answers land here as
 * `kind: "btw"`, and a failed side question sets `isError` with the reason in
 * `text` — knowing that instantly is what keeps a broken run from burning the
 * whole timeout.
 */
function readSideResult(
  event: EventFrame,
  runId: string,
): { isError: boolean; text: string } | undefined {
  if (event.event !== "chat.side_result") {
    return undefined;
  }
  const payload = event.payload;
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (record.kind !== "btw" || record.runId !== runId) {
    return undefined;
  }
  return {
    isError: record.isError === true,
    text: typeof record.text === "string" ? record.text : "",
  };
}

/**
 * Side-question replies do not always surface as a `chat` final frame for the
 * originating runId, so accept the `chat.side_result` frame, any gateway frame
 * carrying the echo token, or the app-server's own `item/completed`
 * agentMessage from the stdio capture. An errored `chat.side_result` fails the
 * run immediately with the gateway's own reason.
 */
async function waitForSideQuestionEcho(params: {
  client: GatewayClient;
  command: string;
  events: EventFrame[];
  proofDir: string;
  sessionKey: string;
  token: string;
  timeoutMs: number;
}): Promise<{ source: string; text: string }> {
  const runId = `idem-${randomUUID()}-relay-proof-side`;
  const started = await params.client.request(
    "chat.send",
    {
      sessionKey: params.sessionKey,
      idempotencyKey: runId,
      message: params.command,
    },
    { timeoutMs: params.timeoutMs },
  );
  if (started?.status !== "started") {
    throw new Error(`side question did not start: ${JSON.stringify(started)}`);
  }
  const capturePath = path.join(params.proofDir, "rpc-out.jsonl");
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    // Fail fast: the gateway already knows the side question is dead, so do not
    // sit out the remaining timeout waiting for an echo that cannot arrive.
    const sideResult = params.events
      .map((event) => readSideResult(event, runId))
      .find((result) => result !== undefined);
    if (sideResult?.isError) {
      await fs.writeFile(
        path.join(params.proofDir, "side-question-error.json"),
        `${JSON.stringify({ runId, token: params.token, text: sideResult.text }, null, 2)}\n`,
      );
      throw new Error(`side question failed: ${sideResult.text.trim() || "(no reason reported)"}`);
    }
    if (sideResult && sideResult.text.includes(params.token)) {
      return { source: "gateway-side-result", text: sideResult.text };
    }
    const final = params.events
      .map((event) => extractChatFinalText(event, runId))
      .find((text) => typeof text === "string" && text.includes(params.token));
    if (final) {
      return { source: "gateway-chat-final", text: final };
    }
    const frame = params.events.find((event) => {
      const serialized = JSON.stringify(event);
      return serialized.includes(params.token) && !serialized.includes("/btw");
    });
    if (frame) {
      return { source: "gateway-event", text: JSON.stringify(frame) };
    }
    const captured = await readCapturedAgentMessage(capturePath, params.token);
    if (captured) {
      return { source: "app-server-capture", text: captured };
    }
    await delay(250);
  }
  await fs.writeFile(
    path.join(params.proofDir, "side-question-events-debug.json"),
    `${JSON.stringify(params.events.slice(-60), null, 2)}\n`,
  );
  throw new Error(`timed out waiting for side-question echo ${params.token}`);
}

/**
 * Drives one approval round-trip: a single agent turn running a command Codex
 * cannot classify as trusted, then the `item/commandExecution/requestApproval`
 * request the app-server raised and the decision the gateway answered with.
 * A denial is still proof of enforcement, so only the round-trip is asserted.
 */
async function runApprovalProofTurn(params: {
  client: GatewayClient;
  mode: StaticRelayProofMode;
  proofDir: string;
  receipt: Record<string, unknown>;
  sessionKey: string;
  upperMode: string;
}): Promise<void> {
  const nonce = randomBytes(3).toString("hex").toUpperCase();
  const echoToken = `APPROVAL-${params.upperMode}-${nonce}`;
  const command = resolveApprovalCommand(echoToken);
  const approval: Record<string, unknown> = {
    method: CODEX_APPROVAL_REQUEST_METHOD,
    command,
    echoToken,
  };
  // Attach by reference before anything can throw: later mutations land in the
  // receipt even when the round-trip assertions below fail.
  params.receipt.approval = approval;
  try {
    const turn = await requestAgentTextWithEvents({
      client: params.client,
      sessionKey: params.sessionKey,
      // Under `on-request` the escalation is the model's call, not the sandbox's,
      // so ask for it outright instead of engineering a command the sandbox has
      // to refuse first. That keeps the command side-effect-free and makes the
      // approval deterministic rather than dependent on a denial being reachable.
      message: `Use your shell tool to run this exact command: ${command}\nRun it with escalated sandbox permissions (request escalated permissions on the shell call) so the operator is asked to approve it. Do not rewrite the command and do not run it without requesting the escalation.\nThen reply with exactly the command's stdout and nothing else.`,
    });
    approval.text = turn.text.trim().slice(0, 400);
    approval.echoTokenSeen = turn.text.includes(echoToken);
    Object.assign(approval, readLifecycleIdentity(turn.events));
  } catch (error) {
    // A denied or unanswered approval can fail the turn itself; the captured
    // round-trip below is the actual proof, so keep it rather than bailing out.
    approval.turnError = error instanceof Error ? error.message : String(error);
  }
  const roundTrip = await readCapturedApprovalRoundTrip({
    proofDir: params.proofDir,
    timeoutMs: APPROVAL_CAPTURE_TIMEOUT_MS,
  });
  await assertCapturedCodexHookOverlay({
    proofDir: params.proofDir,
    method: "thread/start",
    label: `${params.mode} attempt`,
    expected: RELAY_PROOF_EXPECTED_OVERLAYS[params.mode].attempt,
    timeoutMs: CAPTURE_FRAME_TIMEOUT_MS,
  });
  approval.requestId = roundTrip.request?.id ?? null;
  approval.requestParams = roundTrip.request?.params ?? null;
  approval.response = roundTrip.response ?? null;
  approval.decision = roundTrip.response ? readApprovalDecision(roundTrip.response) : undefined;
  expect(
    roundTrip.request,
    `no ${CODEX_APPROVAL_REQUEST_METHOD} request captured for command: ${command}`,
  ).toBeTruthy();
  expect(
    roundTrip.response,
    `no gateway response captured for ${CODEX_APPROVAL_REQUEST_METHOD} id ${String(roundTrip.request?.id)}`,
  ).toBeTruthy();
}

/**
 * Pairs the app-server's approval request (`rpc-out.jsonl`) with the gateway's
 * response by JSON-RPC id (`rpc-in.jsonl`). Polls because the tee appends after
 * the turn already settled. Returns whatever it has at the deadline so a partial
 * round-trip is still recorded in the receipt.
 */
async function readCapturedApprovalRoundTrip(params: {
  proofDir: string;
  timeoutMs: number;
}): Promise<{ request?: Record<string, unknown>; response?: Record<string, unknown> }> {
  const requestPath = path.join(params.proofDir, "rpc-out.jsonl");
  const responsePath = path.join(params.proofDir, "rpc-in.jsonl");
  const deadline = Date.now() + params.timeoutMs;
  let request: Record<string, unknown> | undefined;
  for (;;) {
    request ??= (await readCapturedJsonRpcRecords(requestPath)).find(
      (record) => record.method === CODEX_APPROVAL_REQUEST_METHOD,
    );
    const requestId = request?.id;
    if (requestId !== undefined) {
      const response = (await readCapturedJsonRpcRecords(responsePath)).find(
        (record) => record.method === undefined && record.id === requestId,
      );
      if (response) {
        return { request, response };
      }
    }
    if (Date.now() >= deadline) {
      return request ? { request } : {};
    }
    await delay(CAPTURE_POLL_MS);
  }
}

function readApprovalDecision(response: Record<string, unknown>): string | undefined {
  const result = response.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const decision = (result as Record<string, unknown>).decision;
    if (typeof decision === "string") {
      return decision;
    }
  }
  return response.error ? "error" : undefined;
}

async function readCapturedAgentMessage(
  capturePath: string,
  token: string,
): Promise<string | undefined> {
  let text: string;
  try {
    text = await fs.readFile(capturePath, "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    if (!line.includes(token) || !line.includes("agentMessage")) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as {
        method?: string;
        params?: { item?: { text?: unknown; type?: unknown } };
      };
      const item = parsed.params?.item;
      if (
        parsed.method === "item/completed" &&
        item?.type === "agentMessage" &&
        typeof item.text === "string" &&
        item.text.includes(token)
      ) {
        return item.text;
      }
    } catch {
      /* partial line */
    }
  }
  return undefined;
}

/**
 * Reads the `params.config` the app-server actually received for `method` and
 * asserts the whole overlay. Polls because the tee appends after the turn has
 * already settled; a missing frame fails loudly rather than passing vacuously.
 */
async function assertCapturedCodexHookOverlay(params: {
  proofDir: string;
  method: CodexThreadLifecycleMethod;
  label: string;
  expected: CodexHookOverlay;
  timeoutMs: number;
}): Promise<void> {
  const capturePath = path.join(params.proofDir, "rpc-in.jsonl");
  const deadline = Date.now() + params.timeoutMs;
  let frame: Record<string, unknown> | undefined;
  for (;;) {
    frame = (await readCapturedJsonRpcRecords(capturePath)).find(
      (record) => record.method === params.method,
    );
    if (frame || Date.now() >= deadline) {
      break;
    }
    await delay(CAPTURE_POLL_MS);
  }
  expect(
    frame,
    `${params.label}: no ${params.method} frame captured in ${capturePath}`,
  ).toBeTruthy();
  const rawConfig = (frame?.params as { config?: unknown } | undefined)?.config;
  expect(
    rawConfig && typeof rawConfig === "object",
    `${params.label}: ${params.method} carried no params.config`,
  ).toBe(true);
  assertCodexHookOverlay({
    config: rawConfig as Record<string, unknown>,
    expected: params.expected,
    label: params.label,
    method: params.method,
  });
}

/**
 * The overlay each mode must produce on the wire. Kept in lockstep with
 * `expectAttempt` in `proof/extract-evidence.mjs` (the evidence pack's verdict
 * table) — that file lives outside the repo, so the table is duplicated here on
 * purpose; change both together.
 *
 * `disabled-never` is the one that has to stay meaningful: loop detection gives
 * `pre_tool_use` local work without making `hasBeforeToolCallPolicy()` true, so
 * the guard still honors the full opt-out under an effective `"never"` policy
 * while every other mode installs a real relay.
 */
const RELAY_PROOF_EXPECTED_OVERLAYS: Record<
  StaticRelayProofMode,
  { attempt: CodexHookOverlay; fork?: CodexHookOverlay }
> = {
  baseline: {
    attempt: {
      featuresHooks: true,
      hooks: {
        "hooks.PreToolUse": "installed",
        "hooks.PostToolUse": "empty",
        "hooks.PermissionRequest": "absent",
        "hooks.Stop": "empty",
      },
    },
    fork: {
      featuresHooks: true,
      hooks: {
        "hooks.PreToolUse": "installed",
        "hooks.PostToolUse": "empty",
        "hooks.PermissionRequest": "empty",
        "hooks.Stop": "empty",
      },
    },
  },
  // The opt-out clears the relay's own hooks and leaves `features.hooks` alone:
  // disabling that flag would also suppress independent user, project, plugin,
  // and managed Codex hooks the relay never installed.
  "disabled-never": {
    attempt: {
      featuresHooks: "absent",
      hooks: {
        "hooks.PreToolUse": "empty",
        "hooks.PostToolUse": "empty",
        "hooks.PermissionRequest": "empty",
        "hooks.Stop": "empty",
      },
      hookStateDisabled: RELAY_PROOF_OPT_OUT_HOOK_STATE_KEYS,
    },
    fork: {
      featuresHooks: "absent",
      hooks: {
        "hooks.PreToolUse": "empty",
        "hooks.PostToolUse": "empty",
        "hooks.PermissionRequest": "empty",
        "hooks.Stop": "empty",
      },
      hookStateDisabled: RELAY_PROOF_OPT_OUT_HOOK_STATE_KEYS,
    },
  },
  "disabled-active": {
    attempt: {
      featuresHooks: true,
      hooks: {
        "hooks.PreToolUse": "installed",
        "hooks.PostToolUse": "absent",
        "hooks.PermissionRequest": "absent",
        "hooks.Stop": "absent",
      },
    },
    fork: {
      featuresHooks: true,
      hooks: {
        "hooks.PreToolUse": "installed",
        "hooks.PostToolUse": "empty",
        "hooks.PermissionRequest": "empty",
        "hooks.Stop": "empty",
      },
    },
  },
  // Approval modes run no `/btw`, so they have no `thread/fork` frame.
  "approval-baseline": {
    attempt: {
      featuresHooks: true,
      hooks: {
        "hooks.PreToolUse": "installed",
        "hooks.PostToolUse": "empty",
        "hooks.PermissionRequest": "absent",
        "hooks.Stop": "empty",
      },
    },
  },
  "approval-disabled": {
    attempt: {
      featuresHooks: true,
      hooks: {
        "hooks.PreToolUse": "installed",
        "hooks.PostToolUse": "absent",
        "hooks.PermissionRequest": "absent",
        "hooks.Stop": "absent",
      },
    },
  },
};

describeLive("gateway live (Codex native hook relay config proof)", () => {
  it(
    "sends the resolved native hook relay overlay to a real Codex app-server",
    async () => {
      const mode = resolveStaticRelayProofMode();
      await runCodexRelayProofLane({
        mode,
        body: async (lane) => {
          const { client, events, proofDir, receipt, sessionKey, upperMode } = lane;
          if (isRelayProofApprovalMode(mode)) {
            // Approval modes run a single turn: the round-trip is the evidence, and
            // the approval bridge is shared by the attempt and side-question paths.
            await runApprovalProofTurn({
              client,
              mode,
              proofDir,
              receipt,
              sessionKey,
              upperMode,
            });
            return;
          }
          const attemptNonce = randomBytes(3).toString("hex").toUpperCase();
          const attemptToken = `RELAY-PROOF-${upperMode}-${attemptNonce}`;
          const attempt = await requestAgentTextWithEvents({
            client,
            sessionKey,
            message: `Reply with exactly ${attemptToken} and nothing else.`,
          });
          expect(attempt.text).toContain(attemptToken);
          const attemptIdentity = readLifecycleIdentity(attempt.events);
          receipt.attempt = {
            echoToken: attemptToken,
            text: attempt.text.trim(),
            ...attemptIdentity,
          };
          expect(attemptIdentity.threadId).toBeTruthy();
          await assertCapturedCodexHookOverlay({
            proofDir,
            method: "thread/start",
            label: `${mode} attempt`,
            expected: RELAY_PROOF_EXPECTED_OVERLAYS[mode].attempt,
            timeoutMs: CAPTURE_FRAME_TIMEOUT_MS,
          });

          const sideNonce = randomBytes(3).toString("hex").toUpperCase();
          const sideToken = `RELAY-SIDE-${upperMode}-${sideNonce}`;
          const side = await waitForSideQuestionEcho({
            client,
            command: `/btw Reply with exactly ${sideToken} and nothing else.`,
            events,
            proofDir,
            sessionKey,
            token: sideToken,
            timeoutMs: REQUEST_TIMEOUT_MS,
          });
          expect(side.text).toContain(sideToken);
          receipt.sideQuestion = {
            echoToken: sideToken,
            source: side.source,
            text: side.text.trim().slice(0, 400),
          };
          const forkOverlay = RELAY_PROOF_EXPECTED_OVERLAYS[mode].fork;
          expect(forkOverlay, `${mode}: missing fork overlay expectation`).toBeTruthy();
          if (forkOverlay) {
            await assertCapturedCodexHookOverlay({
              proofDir,
              method: "thread/fork",
              label: `${mode} side question`,
              expected: forkOverlay,
              timeoutMs: CAPTURE_FRAME_TIMEOUT_MS,
            });
          }
        },
      });
    },
    TEST_TIMEOUT_MS,
  );
});
