// Live proof lane for the existing-session `transition` mode: three sequential
// turns on ONE gateway, ONE session and ONE native Codex thread while an operator
// flips `appServer.nativeHookRelay.enabled` between them, with an independent
// Codex user-layer hook installed for the whole run to prove the opt-out never
// reaches beyond OpenClaw's own hooks.
//
// The five static configuration modes are proved by the sibling lane in
// `gateway-codex-harness.native-hook-relay-proof.live.test.ts`; the shared
// harness (gateway, capture directory, overlay assertions) lives in
// `gateway-codex-harness.native-hook-relay-proof.test-helpers.ts`, which also
// documents the opt-in environment.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { GatewayClient } from "../client.js";
import {
  assertCodexHookOverlay,
  CAPTURE_FRAME_TIMEOUT_MS,
  CAPTURE_POLL_MS,
  type CodexHookOverlay,
  type CodexThreadLifecycleMethod,
  isRelayProofLaneEnabled,
  readCapturedJsonRpcRecords,
  readLifecycleIdentity,
  RELAY_PROOF_OPT_OUT_HOOK_STATE_KEYS,
  RELAY_PROOF_SESSION_FLAGS_STATE_KEY_PREFIXES,
  type RelayProofLane,
  type RelayProofTransitionRelayConfig,
  requestAgentTextWithEvents,
  resolveRelayProofMode,
  runCodexRelayProofLane,
  TEST_TIMEOUT_MS,
} from "./gateway-codex-harness.native-hook-relay-proof.test-helpers.js";

const describeLive = isRelayProofLaneEnabled(["transition"]) ? describe : describe.skip;

const CODEX_THREAD_LIFECYCLE_METHODS = new Set<string>([
  "thread/start",
  "thread/resume",
  "thread/fork",
]);

type CapturedThreadLifecycleFrame = {
  method: CodexThreadLifecycleMethod;
  config: Record<string, unknown>;
  threadId?: string;
};

function isCodexThreadLifecycleMethod(value: unknown): value is CodexThreadLifecycleMethod {
  return typeof value === "string" && CODEX_THREAD_LIFECYCLE_METHODS.has(value);
}

/** Every config-bearing thread lifecycle frame the gateway sent, in wire order. */
async function readCapturedThreadLifecycleFrames(
  proofDir: string,
): Promise<CapturedThreadLifecycleFrame[]> {
  const records = await readCapturedJsonRpcRecords(path.join(proofDir, "rpc-in.jsonl"));
  const frames: CapturedThreadLifecycleFrame[] = [];
  for (const record of records) {
    if (!isCodexThreadLifecycleMethod(record.method)) {
      continue;
    }
    const params = (record.params ?? {}) as Record<string, unknown>;
    const config = params.config;
    frames.push({
      method: record.method,
      config: config && typeof config === "object" ? (config as Record<string, unknown>) : {},
      ...(typeof params.threadId === "string" ? { threadId: params.threadId } : {}),
    });
  }
  return frames;
}

/**
 * Waits for the frames this phase put on the wire. Returns everything captured
 * after `from`; an empty result is a real failure signal (it means the turn
 * reused the loaded thread and never re-sent config), so the caller asserts on it.
 */
async function waitForNewThreadLifecycleFrames(params: {
  from: number;
  proofDir: string;
  timeoutMs: number;
}): Promise<CapturedThreadLifecycleFrame[]> {
  const deadline = Date.now() + params.timeoutMs;
  for (;;) {
    const frames = (await readCapturedThreadLifecycleFrames(params.proofDir)).slice(params.from);
    if (frames.length > 0 || Date.now() >= deadline) {
      return frames;
    }
    await delay(CAPTURE_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Independent (non-OpenClaw) Codex user-layer hook
// ---------------------------------------------------------------------------

const INDEPENDENT_HOOK_STATUS_MESSAGE = "independent operator hook (not OpenClaw)";
const INDEPENDENT_HOOK_MARKER_FILENAME = "independent-user-hook.log";
const INDEPENDENT_HOOK_CONFIG_FILENAME = "independent-user-hook-config.toml";
const INDEPENDENT_HOOK_TIMEOUT_SEC = 15;
const INDEPENDENT_HOOK_MARKER_TIMEOUT_MS = 60_000;

/**
 * Codex's trust identity for one normalized command hook.
 *
 * This mirrors the production `codexCommandHookTrustedHash`
 * (`extensions/codex/src/app-server/native-hook-relay.ts`), which is module-private:
 * sha256 over the canonical (key-sorted) JSON of the TOML value Codex itself
 * hashes (`codex-rs/config/src/fingerprint.rs: version_for_toml` →
 * `codex-rs/hooks/src/engine/discovery.rs: hook_hash`). An untrusted hook is
 * discovered but never executed, so this hash is what makes the independent hook
 * a live participant rather than a config decoration.
 */
function codexCommandHookTrustedHashForProof(params: {
  command: string;
  eventKeyLabel: string;
  statusMessage: string;
  timeout: number;
}): string {
  const identity = {
    event_name: params.eventKeyLabel,
    hooks: [
      {
        async: false,
        command: params.command,
        statusMessage: params.statusMessage,
        timeout: params.timeout,
        type: "command",
      },
    ],
  };
  const sortJson = (value: unknown): unknown => {
    if (!value || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(sortJson);
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
      sorted[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(sortJson(identity)))
    .digest("hex")}`;
}

type IndependentUserLayerHook = {
  codexHome: string;
  configPath: string;
  configToml: string;
  command: string;
  markerPath: string;
  stateKeys: readonly string[];
};

/**
 * Installs a hook OpenClaw's relay did not write, into the layer whose hook state
 * Codex actually honors.
 *
 * Placement is deliberate on three counts:
 *  - **Layer.** Codex discovers hooks per config layer
 *    (`discovery.rs: layers_low_to_high` → `load_toml_hooks_from_layer`), keying
 *    each handler by its own source path. The relay's opt-out clears the
 *    `<session-flags>` layer's arrays and disables only `<session-flags>` state
 *    keys, so a user-layer hook is a different key entirely and must survive.
 *  - **User layer specifically.** `hook_states_from_stack` (`config_rules.rs`)
 *    reads `hooks.state` from the User and SessionFlags layers only, so a project
 *    layer could not carry its own trust marker.
 *  - **Event.** `Stop` runs once at the end of every turn
 *    (`core/src/hook_runtime.rs: run_turn_stop_hooks`), so each phase produces
 *    evidence without depending on the model choosing to call a tool. It is also
 *    the same event OpenClaw's own relay owns as `before_agent_finalize`, so the
 *    two live at the same `:stop:0:0` index under different source paths.
 */
async function installIndependentUserLayerHook(params: {
  agentDir: string;
  proofDir: string;
}): Promise<IndependentUserLayerHook> {
  // Mirrors `resolveCodexAppServerHomeDir` in the codex extension: with no
  // explicit CODEX_HOME and a non-user home scope, the app-server runs against
  // `<agentDir>/codex-home`, whose `config.toml` is the User config layer.
  const codexHome = path.join(params.agentDir, "codex-home");
  await fs.mkdir(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  const markerPath = path.join(params.proofDir, INDEPENDENT_HOOK_MARKER_FILENAME);
  await fs.writeFile(markerPath, "");
  // Command hooks run through `$SHELL -lc` (`hooks/src/engine/command_runner.rs`),
  // so a redirection is enough. Kept free of backslashes and double quotes: the
  // exact string is both TOML-encoded and trust-hashed.
  const command = `echo independent-user-layer-hook-ran >> '${markerPath}'`;
  const trustedHash = codexCommandHookTrustedHashForProof({
    command,
    eventKeyLabel: "stop",
    statusMessage: INDEPENDENT_HOOK_STATUS_MESSAGE,
    timeout: INDEPENDENT_HOOK_TIMEOUT_SEC,
  });
  // Codex canonicalizes its home before building layer paths (on macOS the
  // temp dir resolves under /private), and the state key is the layer's own
  // displayed path. Write a marker for both spellings, exactly as the relay
  // does for its two `<session-flags>` forms.
  const realConfigPath = await fs
    .realpath(codexHome)
    .then((resolved) => path.join(resolved, "config.toml"))
    .catch(() => configPath);
  const stateKeys = [...new Set([configPath, realConfigPath])].map((file) => `${file}:stop:0:0`);
  const configToml = [
    "# Independent operator hook. OpenClaw never writes this file: it is the Codex",
    "# User config layer, and this hook exists only to prove the native hook relay",
    "# opt-out does not reach beyond OpenClaw's own session-layer hooks.",
    "[[hooks.Stop]]",
    "",
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    `command = "${command}"`,
    `timeout = ${INDEPENDENT_HOOK_TIMEOUT_SEC}`,
    "async = false",
    `statusMessage = "${INDEPENDENT_HOOK_STATUS_MESSAGE}"`,
    "",
    "[hooks.state]",
    ...stateKeys.map((key) => `"${key}" = { enabled = true, trusted_hash = "${trustedHash}" }`),
    "",
  ].join("\n");
  await fs.writeFile(configPath, configToml);
  // Keep a copy inside the capture directory: the temp home is deleted with the
  // run, and the evidence pack has to be able to show what was installed.
  await fs.writeFile(path.join(params.proofDir, INDEPENDENT_HOOK_CONFIG_FILENAME), configToml);
  return { codexHome, configPath, configToml, command, markerPath, stateKeys };
}

/**
 * The `CODEX_HOME` the app-server reports for itself in its `initialize` result.
 *
 * Which home a run gets is an auth-routing outcome, not a constant: when the
 * runtime plan defers auth to the native owner and no home is configured,
 * `run-attempt-connection.ts` promotes `homeScope` to `"user"` and the app-server
 * runs against `~/.codex` instead of `<agentDir>/codex-home`. The independent
 * hook can only be installed into a home this lane owns, so the lane reads back
 * which home was actually used instead of assuming one.
 */
async function readCapturedCodexHomes(proofDir: string): Promise<string[]> {
  let text: string;
  try {
    text = await fs.readFile(path.join(proofDir, "rpc-out.jsonl"), "utf8");
  } catch {
    return [];
  }
  const homes = new Set<string>();
  for (const match of text.matchAll(/"codexHome":"((?:[^"\\]|\\.)*)"/g)) {
    try {
      homes.add(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      /* partial line */
    }
  }
  return [...homes];
}

/** True when the app-server ran against the home this lane installed its hook into. */
async function usesInstalledHookCodexHome(params: {
  codexHome: string;
  proofDir: string;
}): Promise<{ homes: string[]; matches: boolean }> {
  const homes = await readCapturedCodexHomes(params.proofDir);
  const candidates = new Set<string>([params.codexHome]);
  try {
    candidates.add(await fs.realpath(params.codexHome));
  } catch {
    /* the home may not exist yet */
  }
  return { homes, matches: homes.some((home) => candidates.has(path.resolve(home))) };
}

async function readIndependentHookRunCount(markerPath: string): Promise<number> {
  try {
    const text = await fs.readFile(markerPath, "utf8");
    return text.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/** Waits for the independent hook to record at least one more run than `from`. */
async function waitForIndependentHookRun(params: {
  from: number;
  markerPath: string;
  timeoutMs: number;
}): Promise<number> {
  const deadline = Date.now() + params.timeoutMs;
  for (;;) {
    const count = await readIndependentHookRunCount(params.markerPath);
    if (count > params.from || Date.now() >= deadline) {
      return count;
    }
    await delay(CAPTURE_POLL_MS);
  }
}

/** Reads the operator-authored relay key back out of a loaded config. */
function readConfiguredNativeHookRelay(config: OpenClawConfig): unknown {
  const entries = (config.plugins as { entries?: Record<string, { config?: unknown }> } | undefined)
    ?.entries;
  const codexConfig = entries?.codex?.config as
    | { appServer?: { nativeHookRelay?: unknown } }
    | undefined;
  return codexConfig?.appServer?.nativeHookRelay;
}

/**
 * Returns a copy of `config` whose codex plugin entry carries `relay`, sharing
 * every other node with the original.
 *
 * The narrow structural clone is the point. The published runtime config is the
 * identity several runtime owners are keyed on, so the flip must change exactly
 * the operator-authored key and nothing else.
 */
function withConfiguredNativeHookRelay(
  config: OpenClawConfig,
  relay: RelayProofTransitionRelayConfig,
): OpenClawConfig {
  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  const entries = (plugins.entries ?? {}) as Record<string, unknown>;
  const codex = (entries.codex ?? {}) as Record<string, unknown>;
  const codexConfig = (codex.config ?? {}) as Record<string, unknown>;
  const appServer = { ...((codexConfig.appServer ?? {}) as Record<string, unknown>) };
  if (relay === undefined) {
    delete appServer.nativeHookRelay;
  } else {
    appServer.nativeHookRelay = { ...relay };
  }
  return {
    ...config,
    plugins: {
      ...plugins,
      entries: {
        ...entries,
        codex: { ...codex, config: { ...codexConfig, appServer } },
      },
    },
  } as OpenClawConfig;
}

/**
 * Applies the operator edit to the RUNNING gateway.
 *
 * The authored file is rewritten first, so the on-disk config and the running
 * gateway agree. Then the published runtime config — the object
 * `resolveAttemptPluginConfig(params.config)` reads on the next attempt
 * (`extensions/codex/harness.ts`) — is advanced to a copy that differs only in
 * the relay key.
 *
 * `advancePreparedModelRuntimeConfig` is not optional bookkeeping: the prepared
 * model-runtime owners are keyed on the exact config identity they were published
 * with, and a turn run against a config they have not been advanced to fails with
 * "prepared model catalog owner config was replaced during the read". This is the
 * same in-place advance the gateway's own reloader performs for a change that does
 * not affect provider auth (`server-reload-managed.ts: onRuntimeConfigCommitted`),
 * which is exactly what a codex app-server relay key is.
 */
async function reloadOperatorRelayConfig(
  lane: RelayProofLane,
  relay: RelayProofTransitionRelayConfig,
): Promise<Record<string, unknown>> {
  const { getRuntimeConfigSnapshot, getRuntimeConfigSourceSnapshot, setRuntimeConfigSnapshot } =
    await import("../../config/config.js");
  const { advancePreparedModelRuntimeConfig } =
    await import("../../agents/prepared-model-runtime.js");
  const written = await lane.writeOperatorRelayConfig(relay);
  const current = getRuntimeConfigSnapshot();
  if (!current) {
    throw new Error("the gateway published no runtime config snapshot");
  }
  const next = withConfiguredNativeHookRelay(current, relay);
  setRuntimeConfigSnapshot(next, getRuntimeConfigSourceSnapshot() ?? current);
  advancePreparedModelRuntimeConfig(next);
  // Fail before spending a turn if the flip did not take: without this the lane
  // would blame the app-server for a gateway-side miss.
  expect(
    JSON.stringify(readConfiguredNativeHookRelay(getRuntimeConfigSnapshot() ?? next) ?? null),
    "the published runtime config does not carry the flipped nativeHookRelay value",
  ).toBe(JSON.stringify(relay ?? null));
  return written;
}

/**
 * The relay-installed overlay under an effective `approvalPolicy: "never"`, which
 * is the policy the transition lane pins. It differs from `baseline` in exactly
 * one cell: with approvals off, `resolveCodexNativeHookRelayEvents` stops
 * excluding `permission_request`, and that event's local-work predicate is
 * unconditionally true, so the relay installs a real command there too.
 */
const RELAY_PROOF_TRANSITION_RELAY_INSTALLED_OVERLAY: CodexHookOverlay = {
  featuresHooks: true,
  hooks: {
    "hooks.PreToolUse": "installed",
    "hooks.PostToolUse": "empty",
    "hooks.PermissionRequest": "installed",
    "hooks.Stop": "empty",
  },
};

/** The honored full opt-out, identical to what `disabled-never` records. */
const RELAY_PROOF_TRANSITION_OPT_OUT_OVERLAY: CodexHookOverlay = {
  featuresHooks: "absent",
  hooks: {
    "hooks.PreToolUse": "empty",
    "hooks.PostToolUse": "empty",
    "hooks.PermissionRequest": "empty",
    "hooks.Stop": "empty",
  },
  hookStateDisabled: RELAY_PROOF_OPT_OUT_HOOK_STATE_KEYS,
};

/**
 * The three phases of the `transition` lane, in order, on ONE gateway process,
 * ONE session key and ONE native thread.
 *
 * `method` is what the phase must put on the wire, and it is the load-bearing
 * part of this table:
 *
 *  - Phase 1 has no binding yet, so it is a `thread/start`.
 *  - Phases 2 and 3 resume the SAME thread. They cannot be served by the warm
 *    live-thread path (`thread-lifecycle-warm.ts`) because that path fingerprints
 *    the merged thread config it would resume with — `fingerprintCodexThreadConfig`
 *    hashes `request.config` — and the flipped relay overlay changes it. The
 *    mismatch returns `{ kind: "resume" }`, which sends a real `thread/resume`
 *    carrying the whole rebuilt config, overlay included. An unchanged overlay
 *    would instead reuse the loaded thread and send no frame at all, so a missing
 *    frame here is exactly the failure this lane must catch.
 */
const RELAY_PROOF_TRANSITION_PHASES = [
  {
    id: "relay-on",
    label: "relay enabled (no `nativeHookRelay` key — historical default)",
    relay: undefined,
    method: "thread/start",
    lifecycleAction: "started",
    overlay: RELAY_PROOF_TRANSITION_RELAY_INSTALLED_OVERLAY,
  },
  {
    id: "relay-off",
    label: "operator flips `nativeHookRelay.enabled: false` mid-session",
    relay: { enabled: false },
    method: "thread/resume",
    lifecycleAction: "resumed",
    overlay: RELAY_PROOF_TRANSITION_OPT_OUT_OVERLAY,
  },
  {
    id: "relay-restored",
    label: "operator flips `nativeHookRelay.enabled: true` back on",
    relay: { enabled: true },
    method: "thread/resume",
    lifecycleAction: "resumed",
    overlay: RELAY_PROOF_TRANSITION_RELAY_INSTALLED_OVERLAY,
  },
] as const satisfies readonly {
  id: string;
  label: string;
  relay: RelayProofTransitionRelayConfig;
  method: CodexThreadLifecycleMethod;
  lifecycleAction: string;
  overlay: CodexHookOverlay;
}[];

/**
 * Drives the existing-session enable → disable → enable sequence.
 *
 * One gateway, one session key, one native thread, three real turns. Between
 * turns the operator's `openclaw.json` is rewritten and the gateway's pinned
 * runtime config snapshot is reloaded — the same object
 * `resolveAttemptPluginConfig(params.config)` reads on the next attempt
 * (`extensions/codex/harness.ts`), so the flip is picked up per attempt rather
 * than per registration.
 *
 * Every phase asserts three things, and each of them fails the run loudly:
 *  1. the frames this phase put on the wire are exactly the expected lifecycle
 *     method, and each carries the expected overlay;
 *  2. the thread identity is unchanged, so this really is one existing session
 *     rather than a fresh thread per configuration;
 *  3. the independent user-layer hook ran again during the phase.
 */
async function runTransitionProofTurns(params: {
  client: GatewayClient;
  independentHook: IndependentUserLayerHook;
  proofDir: string;
  receipt: Record<string, unknown>;
  reloadOperatorConfig: (
    relayOverride: RelayProofTransitionRelayConfig,
  ) => Promise<Record<string, unknown>>;
  sessionKey: string;
}): Promise<void> {
  const phaseReceipts: Record<string, unknown>[] = [];
  params.receipt.transition = {
    independentHook: {
      configPath: params.independentHook.configPath,
      command: params.independentHook.command,
      markerPath: params.independentHook.markerPath,
      stateKeys: params.independentHook.stateKeys,
      configToml: params.independentHook.configToml,
    },
    phases: phaseReceipts,
  };
  let frameCursor = (await readCapturedThreadLifecycleFrames(params.proofDir)).length;
  let boundThreadId: string | undefined;
  for (const phase of RELAY_PROOF_TRANSITION_PHASES) {
    const phaseReceipt: Record<string, unknown> = { id: phase.id, label: phase.label };
    // Attached by reference before anything can throw, so a failing phase is
    // still described in the receipt.
    phaseReceipts.push(phaseReceipt);
    // Every phase goes through the same operator edit + reload path, including
    // the first: the lane must not be able to pass because one phase was special.
    phaseReceipt.appServerConfig = await params.reloadOperatorConfig(phase.relay);
    const hookRunsBefore = await readIndependentHookRunCount(params.independentHook.markerPath);
    const nonce = randomBytes(3).toString("hex").toUpperCase();
    const echoToken = `RELAY-TRANSITION-${phase.id.toUpperCase()}-${nonce}`;
    phaseReceipt.echoToken = echoToken;
    const turn = await requestAgentTextWithEvents({
      client: params.client,
      sessionKey: params.sessionKey,
      message: `Reply with exactly ${echoToken} and nothing else.`,
    });
    phaseReceipt.text = turn.text.trim();
    expect(turn.text, `${phase.id}: the model did not echo ${echoToken}`).toContain(echoToken);
    const identity = readLifecycleIdentity(turn.events);
    Object.assign(phaseReceipt, identity);
    const frames = await waitForNewThreadLifecycleFrames({
      from: frameCursor,
      proofDir: params.proofDir,
      timeoutMs: CAPTURE_FRAME_TIMEOUT_MS,
    });
    phaseReceipt.capturedMethods = frames.map((frame) => frame.method);
    expect(
      frames.length,
      `${phase.id}: expected a ${phase.method} frame carrying the current config, captured none — the attempt reused the loaded thread instead of re-sending config`,
    ).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(
        frame.method,
        `${phase.id}: unexpected lifecycle frame on the wire (expected ${phase.method})`,
      ).toBe(phase.method);
      assertCodexHookOverlay({
        config: frame.config,
        expected: phase.overlay,
        label: `transition ${phase.id}`,
        method: frame.method,
      });
      // The blast radius, asserted rather than argued: every `hooks.state` key
      // OpenClaw writes must name its own `<session-flags>` layer. Codex keys hook
      // state by source path (`hooks/src/lib.rs: hook_key`), so a config that
      // names no other source path cannot enable, disable, or re-trust a hook from
      // any other layer — user, project, plugin, or managed — at any index.
      const hookState = frame.config["hooks.state"];
      const stateKeys =
        hookState && typeof hookState === "object" && !Array.isArray(hookState)
          ? Object.keys(hookState as Record<string, unknown>)
          : [];
      const foreignStateKeys = stateKeys.filter(
        (key) =>
          !RELAY_PROOF_SESSION_FLAGS_STATE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)),
      );
      expect(
        foreignStateKeys,
        `${phase.id}: OpenClaw addressed hook state outside its own session-flags layer`,
      ).toEqual([]);
      expect(
        frame.config["features.hooks"],
        `${phase.id}: the overlay must never switch the Codex hook engine off`,
      ).not.toBe(false);
    }
    frameCursor += frames.length;
    expect(identity.threadId, `${phase.id}: no thread id reported for the turn`).toBeTruthy();
    expect(
      identity.action,
      `${phase.id}: the app-server thread lifecycle action for this turn`,
    ).toBe(phase.lifecycleAction);
    if (boundThreadId === undefined) {
      boundThreadId = identity.threadId;
    } else {
      expect(
        identity.threadId,
        `${phase.id}: the session rotated to a new native thread; this lane must stay on one thread`,
      ).toBe(boundThreadId);
    }
    // Execution evidence is only claimable when the app-server ran against the
    // home this lane owns. When auth routing puts it on the operator's native
    // `~/.codex` (which this lane must not write to), the independence claim
    // rests on the wire assertions above instead — and says so, rather than
    // asserting something the run could not observe.
    const codexHome = await usesInstalledHookCodexHome({
      codexHome: params.independentHook.codexHome,
      proofDir: params.proofDir,
    });
    phaseReceipt.codexHomes = codexHome.homes;
    phaseReceipt.independentHookLayerActive = codexHome.matches;
    if (codexHome.matches) {
      const hookRunsAfter = await waitForIndependentHookRun({
        from: hookRunsBefore,
        markerPath: params.independentHook.markerPath,
        timeoutMs: INDEPENDENT_HOOK_MARKER_TIMEOUT_MS,
      });
      phaseReceipt.independentHookRuns = { before: hookRunsBefore, after: hookRunsAfter };
      expect(
        hookRunsAfter,
        `${phase.id}: the independent user-layer Stop hook did not run during this phase`,
      ).toBeGreaterThan(hookRunsBefore);
    } else {
      phaseReceipt.independentHookRuns = { before: hookRunsBefore, after: hookRunsBefore };
      phaseReceipt.independentHookNote =
        "the app-server ran against the operator's native Codex home, which this lane does not write to; the independent hook was installed but not loaded";
    }
  }
  (params.receipt.transition as Record<string, unknown>).threadId = boundThreadId;
}

describeLive("gateway live (Codex native hook relay existing-session transition)", () => {
  it(
    "keeps one thread while an operator flips nativeHookRelay.enabled off and back on",
    async () => {
      const mode = resolveRelayProofMode();
      let independentHook: IndependentUserLayerHook | undefined;
      await runCodexRelayProofLane({
        mode,
        // The independent hook goes into the Codex User config layer before any
        // app-server starts, so it is present for the whole run and cannot be
        // attributed to OpenClaw.
        prepare: async (context) => {
          independentHook = await installIndependentUserLayerHook(context);
        },
        body: async (lane) => {
          if (!independentHook) {
            throw new Error("transition mode requires the independent user-layer hook");
          }
          await runTransitionProofTurns({
            client: lane.client,
            independentHook,
            proofDir: lane.proofDir,
            receipt: lane.receipt,
            reloadOperatorConfig: (relay) => reloadOperatorRelayConfig(lane, relay),
            sessionKey: lane.sessionKey,
          });
        },
      });
    },
    TEST_TIMEOUT_MS,
  );
});
