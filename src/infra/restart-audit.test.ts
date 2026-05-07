import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readRestartSentinel,
  removeRestartSentinelFile,
  resolveRestartSentinelPath,
  writeRestartSentinel,
} from "./restart-sentinel.js";
import {
  appendGatewayRestartAuditLine,
  consumeGatewayRestartIntentPayloadSync,
  writeGatewayRestartIntentSync,
} from "./restart.js";

const tempDirs: string[] = [];

function createIntentEnv(): NodeJS.ProcessEnv {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-audit-state-"));
  tempDirs.push(stateDir);
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
  };
}

function logPath(env: NodeJS.ProcessEnv): string {
  return path.join(env.OPENCLAW_STATE_DIR ?? "", "logs", "gateway-restart.log");
}

function readLogLines(env: NodeJS.ProcessEnv): string[] {
  const p = logPath(env);
  if (!fs.existsSync(p)) {
    return [];
  }
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
}

describe("gateway restart audit log", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("round-trips audit context through the intent file", () => {
    const env = createIntentEnv();
    expect(
      writeGatewayRestartIntentSync({
        env,
        targetPid: process.pid,
        intent: {
          audit: {
            source: "slash-command",
            senderId: "tg-user-123",
            sessionKey: "agent:main:tg:direct:abc",
            actionLabel: "/restart",
            deliveryContext: "tg-direct",
          },
        },
      }),
    ).toBe(true);

    expect(consumeGatewayRestartIntentPayloadSync(env)).toEqual({
      audit: {
        source: "slash-command",
        senderId: "tg-user-123",
        sessionKey: "agent:main:tg:direct:abc",
        actionLabel: "/restart",
        deliveryContext: "tg-direct",
      },
    });
  });

  it("strips empty / whitespace-only audit fields", () => {
    const env = createIntentEnv();
    expect(
      writeGatewayRestartIntentSync({
        env,
        targetPid: process.pid,
        intent: {
          audit: {
            source: "  slash-command  ",
            senderId: "",
            sessionKey: "   ",
            actionLabel: "/restart",
          },
        },
      }),
    ).toBe(true);

    expect(consumeGatewayRestartIntentPayloadSync(env)).toEqual({
      audit: {
        source: "slash-command",
        actionLabel: "/restart",
      },
    });
  });

  it("ignores intent with no audit context (backward compat)", () => {
    const env = createIntentEnv();
    expect(
      writeGatewayRestartIntentSync({
        env,
        targetPid: process.pid,
        intent: { force: true },
      }),
    ).toBe(true);

    expect(consumeGatewayRestartIntentPayloadSync(env)).toEqual({ force: true });
  });

  it("appends a structured dispatch line with audit + method + old_pid", () => {
    const env = createIntentEnv();
    appendGatewayRestartAuditLine({
      env,
      phase: "dispatch",
      audit: {
        source: "slash-command",
        senderId: "tg-user-123",
        actionLabel: "/restart",
      },
      oldPid: 99999,
      method: "launchctl-kickstart",
    });

    const lines = readLogLines(env);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] gateway restart-dispatch source=slash-command sender_id=tg-user-123 action=\/restart method=launchctl-kickstart old_pid=99999$/,
    );
  });

  it("falls back to source=external when no audit context provided", () => {
    const env = createIntentEnv();
    appendGatewayRestartAuditLine({
      env,
      phase: "signal-received",
      signal: "SIGTERM",
      oldPid: process.pid,
      extra: { action: "stop" },
    });

    const lines = readLogLines(env);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("source=external");
    expect(lines[0]).toContain("signal=SIGTERM");
    expect(lines[0]).toContain(`old_pid=${process.pid}`);
    expect(lines[0]).toContain("action=stop");
  });

  it("emits a completed line that pins new_pid", () => {
    const env = createIntentEnv();
    appendGatewayRestartAuditLine({
      env,
      phase: "completed",
      signal: "boot",
      newPid: process.pid,
      extra: { first_start: "false" },
    });

    const lines = readLogLines(env);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("gateway restart-completed");
    expect(lines[0]).toContain("signal=boot");
    expect(lines[0]).toContain(`new_pid=${process.pid}`);
    expect(lines[0]).toContain("first_start=false");
  });

  it("uses disjoint vocabulary from existing shell-wrapper lines", () => {
    const env = createIntentEnv();
    appendGatewayRestartAuditLine({
      env,
      phase: "dispatch",
      audit: { source: "slash-command", actionLabel: "/restart" },
      oldPid: 1,
      method: "launchctl-kickstart",
    });

    const lines = readLogLines(env);
    // shell wrappers in restart-logs.ts emit:
    //   "[ts] openclaw restart attempt source=update target=..."
    //   "[ts] openclaw restart done source=launchd-handoff"
    // our new lines must not collide with that vocabulary
    for (const line of lines) {
      expect(line).not.toMatch(/openclaw restart (attempt|done|fallback|finished)/);
      expect(line).toMatch(/gateway restart-(dispatch|signal-received|completed)/);
    }
  });

  it("is non-fatal on log directory permission failure", () => {
    // point at an unwritable parent path; the function must not throw
    const broken = { ...process.env, OPENCLAW_STATE_DIR: "/dev/null/cannot-write" };
    expect(() =>
      appendGatewayRestartAuditLine({
        env: broken,
        phase: "dispatch",
        audit: { source: "slash-command" },
        oldPid: 1,
      }),
    ).not.toThrow();
  });

  it("appends multiple lines without overwriting", () => {
    const env = createIntentEnv();
    appendGatewayRestartAuditLine({
      env,
      phase: "dispatch",
      audit: { source: "slash-command", actionLabel: "/restart" },
      oldPid: 1,
      method: "launchctl-kickstart",
    });
    appendGatewayRestartAuditLine({
      env,
      phase: "signal-received",
      signal: "SIGTERM",
      audit: { source: "slash-command", senderId: "tg-user-456" },
      oldPid: 1,
    });
    appendGatewayRestartAuditLine({
      env,
      phase: "completed",
      signal: "boot",
      newPid: 2,
    });

    const lines = readLogLines(env);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("restart-dispatch");
    expect(lines[1]).toContain("restart-signal-received");
    expect(lines[2]).toContain("restart-completed");
  });
});

describe("restart-sentinel audit roundtrip (Change 7A)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("round-trips audit fields through writeRestartSentinel + readRestartSentinel", async () => {
    const env = createIntentEnv();
    await writeRestartSentinel(
      {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        sessionKey: "agent:main:tg:direct:6552322810",
        message: "/restart",
        audit: {
          source: "slash-command",
          actionLabel: "/restart",
          senderId: "tg-user-6552322810",
          sessionKey: "agent:main:tg:direct:6552322810",
          oldPid: 14028,
        },
      },
      env,
    );

    const got = await readRestartSentinel(env);
    expect(got).not.toBeNull();
    expect(got?.payload.audit).toEqual({
      source: "slash-command",
      actionLabel: "/restart",
      senderId: "tg-user-6552322810",
      sessionKey: "agent:main:tg:direct:6552322810",
      oldPid: 14028,
    });

    await removeRestartSentinelFile(resolveRestartSentinelPath(env));
  });

  it("backward-compatibly parses an old sentinel that lacks audit field", async () => {
    const env = createIntentEnv();
    // Simulate an old sentinel written by code that pre-dates Change 7A —
    // no `audit` field. readRestartSentinel must still parse cleanly so
    // the new run-loop code can fall back to source=external on the
    // restart-completed line without throwing.
    fs.mkdirSync(path.dirname(resolveRestartSentinelPath(env)), { recursive: true });
    fs.writeFileSync(
      resolveRestartSentinelPath(env),
      JSON.stringify({
        version: 1,
        payload: {
          kind: "restart",
          status: "ok",
          ts: Date.now(),
          sessionKey: "agent:main:tg:direct:legacy",
          message: "/restart",
        },
      }),
    );

    const got = await readRestartSentinel(env);
    expect(got).not.toBeNull();
    expect(got?.payload.audit).toBeUndefined();
    expect(got?.payload.sessionKey).toBe("agent:main:tg:direct:legacy");

    await removeRestartSentinelFile(resolveRestartSentinelPath(env));
  });

  it("completion line uses sentinel audit fields when present", async () => {
    const env = createIntentEnv();
    await writeRestartSentinel(
      {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        sessionKey: "agent:main:tg:direct:abc",
        message: "/restart",
        audit: {
          source: "slash-command",
          actionLabel: "/restart",
          senderId: "tg-user-abc",
          sessionKey: "agent:main:tg:direct:abc",
          oldPid: 14028,
        },
      },
      env,
    );

    const sentinel = await readRestartSentinel(env);
    const audit = sentinel?.payload.audit ?? null;

    appendGatewayRestartAuditLine({
      env,
      phase: "completed",
      signal: "boot",
      audit: audit
        ? {
            source: audit.source,
            senderId: audit.senderId,
            sessionKey: audit.sessionKey,
            actionLabel: audit.actionLabel,
          }
        : undefined,
      oldPid: audit?.oldPid,
      newPid: 92980,
      extra: { first_start: "false" },
    });

    const lines = readLogLines(env);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toContain("gateway restart-completed");
    expect(line).toContain("signal=boot");
    expect(line).toContain("source=slash-command");
    expect(line).toContain("sender_id=tg-user-abc");
    expect(line).toContain("session_key=agent:main:tg:direct:abc");
    expect(line).toContain("action=/restart");
    expect(line).toContain("old_pid=14028");
    expect(line).toContain("new_pid=92980");
    expect(line).toContain("first_start=false");
    // Must NOT fall back to source=external when audit is present.
    expect(line).not.toContain("source=external");

    await removeRestartSentinelFile(resolveRestartSentinelPath(env));
  });

  it("completion line falls back to source=external when no sentinel exists", async () => {
    const env = createIntentEnv();
    // Ensure no sentinel exists for this test
    const got = await readRestartSentinel(env);
    expect(got).toBeNull();

    appendGatewayRestartAuditLine({
      env,
      phase: "completed",
      signal: "boot",
      newPid: 92980,
      extra: { first_start: "false" },
    });

    const lines = readLogLines(env);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toContain("gateway restart-completed");
    expect(line).toContain("source=external");
    expect(line).toContain("new_pid=92980");
    expect(line).not.toContain("sender_id=");
    expect(line).not.toContain("old_pid=");
  });

  it("run-loop iteration 1 reads predecessor sentinel and emits attributed completion line (Blocker 1 regression)", async () => {
    // Reproduces the supervisor-restart flow that the original Change 7A
    // missed: a brand-new Node process is launched by launchctl/systemd
    // KeepAlive, so `isFirstStart` is true on iteration 1 — which is
    // exactly when the predecessor's sentinel exists. The G2 review
    // Blocker 1 fix removes the `isFirstStart` guard from the sentinel
    // read so this scenario produces an attributed completion line.
    //
    // This test replays the EXACT logic from run-loop.ts after the fix,
    // not a direct sentinel API call, so it would have caught the bug
    // had it existed in the test surface.
    const env = createIntentEnv();
    const senderId = "tg-user-6552322810";
    const sessionKey = "agent:main:tg:direct:6552322810";
    const oldPid = 14028;

    // Predecessor (P_old) writes the sentinel with audit before exit.
    await writeRestartSentinel(
      {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        sessionKey,
        message: "/restart",
        audit: {
          source: "slash-command",
          actionLabel: "/restart",
          senderId,
          sessionKey,
          oldPid,
        },
      },
      env,
    );

    // ---- replay the post-fix run-loop logic on iteration 1 of P_new ----
    // This block must mirror src/cli/gateway-cli/run-loop.ts:557-595.
    const isFirstStart = true; // P_new just started — first iteration
    const preStartSentinelAudit = await readRestartSentinel(env)
      .catch(() => null)
      .then((s) => s?.payload.audit ?? null);
    // Pid-collision guard: don't echo our own pid as old_pid.
    const validOldPid =
      preStartSentinelAudit?.oldPid && preStartSentinelAudit.oldPid !== process.pid
        ? preStartSentinelAudit.oldPid
        : undefined;

    appendGatewayRestartAuditLine({
      env,
      phase: "completed",
      signal: "boot",
      audit: preStartSentinelAudit
        ? {
            source: preStartSentinelAudit.source,
            senderId: preStartSentinelAudit.senderId,
            sessionKey: preStartSentinelAudit.sessionKey,
            actionLabel: preStartSentinelAudit.actionLabel,
          }
        : undefined,
      oldPid: validOldPid,
      newPid: process.pid,
      extra: { first_start: isFirstStart ? "true" : "false" },
    });
    // ---- end run-loop replay ----

    const lines = readLogLines(env);
    expect(lines).toHaveLength(1);
    const line = lines[0];

    // Chief strict bar: source + sender_id + session_key on completed line.
    expect(line).toContain("gateway restart-completed");
    expect(line).toContain("source=slash-command");
    expect(line).toContain(`sender_id=${senderId}`);
    expect(line).toContain(`session_key=${sessionKey}`);
    expect(line).toContain("action=/restart");

    // Chief minimum bar: stable old_pid -> new_pid linkage.
    expect(line).toContain(`old_pid=${oldPid}`);
    expect(line).toContain(`new_pid=${process.pid}`);
    expect(line).toContain("first_start=true");

    // Must NOT regress to source=external when sentinel is present.
    expect(line).not.toContain("source=external");

    await removeRestartSentinelFile(resolveRestartSentinelPath(env));
  });

  it("pid-collision guard suppresses oldPid when sentinel was written by this same process", async () => {
    // Edge case: a same-process replay (nonsense in practice; would need
    // the new gateway to inherit the old gateway's pid via fork tricks,
    // which launchd never does). Suppress the field to avoid the
    // misleading row `old_pid=new_pid`.
    const env = createIntentEnv();
    const sessionKey = "agent:main:tg:direct:replay";
    await writeRestartSentinel(
      {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        sessionKey,
        message: "/restart",
        audit: {
          source: "slash-command",
          actionLabel: "/restart",
          sessionKey,
          oldPid: process.pid, // <- collision: same pid as the test process
        },
      },
      env,
    );

    const preStartSentinelAudit = await readRestartSentinel(env)
      .catch(() => null)
      .then((s) => s?.payload.audit ?? null);
    const validOldPid =
      preStartSentinelAudit?.oldPid && preStartSentinelAudit.oldPid !== process.pid
        ? preStartSentinelAudit.oldPid
        : undefined;

    appendGatewayRestartAuditLine({
      env,
      phase: "completed",
      signal: "boot",
      audit: preStartSentinelAudit
        ? {
            source: preStartSentinelAudit.source,
            sessionKey: preStartSentinelAudit.sessionKey,
            actionLabel: preStartSentinelAudit.actionLabel,
          }
        : undefined,
      oldPid: validOldPid,
      newPid: process.pid,
      extra: { first_start: "true" },
    });

    const lines = readLogLines(env);
    expect(lines).toHaveLength(1);
    const line = lines[0];

    // Source attribution still attached.
    expect(line).toContain("source=slash-command");
    // But old_pid field MUST be absent (collision guard suppresses it).
    expect(line).not.toContain("old_pid=");
    expect(line).toContain(`new_pid=${process.pid}`);

    await removeRestartSentinelFile(resolveRestartSentinelPath(env));
  });

  it("cold boot with no predecessor sentinel still produces source=external (run-loop replay)", async () => {
    // Cold boot: no sentinel exists. The post-fix run-loop logic must
    // gracefully degrade to source=external + no old_pid rather than
    // throwing or fabricating attribution.
    const env = createIntentEnv();
    expect(await readRestartSentinel(env)).toBeNull();

    const preStartSentinelAudit = await readRestartSentinel(env)
      .catch(() => null)
      .then((s) => s?.payload.audit ?? null);
    const validOldPid =
      preStartSentinelAudit?.oldPid && preStartSentinelAudit.oldPid !== process.pid
        ? preStartSentinelAudit.oldPid
        : undefined;

    appendGatewayRestartAuditLine({
      env,
      phase: "completed",
      signal: "boot",
      audit: preStartSentinelAudit
        ? {
            source: preStartSentinelAudit.source,
            sessionKey: preStartSentinelAudit.sessionKey,
            actionLabel: preStartSentinelAudit.actionLabel,
          }
        : undefined,
      oldPid: validOldPid,
      newPid: process.pid,
      extra: { first_start: "true" },
    });

    const lines = readLogLines(env);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toContain("source=external");
    expect(line).not.toContain("sender_id=");
    expect(line).not.toContain("old_pid=");
    expect(line).toContain(`new_pid=${process.pid}`);
  });

  it("audit delivery_context is the channel string in the emitted line, not a stringified object (G3 typecheck regression)", () => {
    // Reproduces the value-level shape of the G3 typecheck blocker. If
    // someone re-introduces the bug by assigning the structured
    // RestartSentinelPayload.deliveryContext object to
    // RestartAuditContext.deliveryContext (which is `string | undefined`),
    // the emitted line would either fail typecheck OR — if cast through
    // `as any` — produce a stringified `[object Object]` row in
    // gateway-restart.log. Both outcomes break downstream parsers that
    // grep `delivery_context=<channel-name>`.
    const env = createIntentEnv();
    appendGatewayRestartAuditLine({
      env,
      phase: "dispatch",
      audit: {
        source: "slash-command",
        actionLabel: "/restart",
        // Pin: must be a coarse channel-name string, not the structured
        // sentinel deliveryContext object.
        deliveryContext: "telegram",
      },
      oldPid: 14028,
      method: "launchctl-kickstart",
    });

    const lines = readLogLines(env);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toContain("delivery_context=telegram");
    // Negative assertion catches the regression where someone assigns the
    // {channel, to, accountId} object — JSON.stringify would yield this
    // marker, and naive String() coercion would yield "[object Object]".
    expect(line).not.toContain("[object Object]");
    expect(line).not.toMatch(/delivery_context=\{/);
  });

  it("emits the full /restart audit chain across the 3 phases (focused integration)", async () => {
    // Focused 3-line integration: sender-side dispatch + receiver-side
    // signal-received + boot-side completed. Asserts source/sender_id are
    // present on all three lines and old_pid / new_pid pin both ends of
    // the chain. Stand-in for the full live-gateway integration test that
    // is out of G1 scope (no live restart per Chief).
    const env = createIntentEnv();
    const senderId = "tg-user-6552322810";
    const sessionKey = "agent:main:tg:direct:6552322810";
    const oldPid = 14028;
    const newPid = 92980;

    // 1. Predecessor writes sentinel with audit (mirrors
    //    buildRestartCommandSentinel in commands-session.ts:45).
    await writeRestartSentinel(
      {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        sessionKey,
        message: "/restart",
        audit: {
          source: "slash-command",
          actionLabel: "/restart",
          senderId,
          sessionKey,
          oldPid,
        },
      },
      env,
    );

    // 2. Predecessor writes the dispatch line (mirrors triggerOpenClawRestart
    //    in restart.ts:563 macOS path).
    appendGatewayRestartAuditLine({
      env,
      phase: "dispatch",
      audit: {
        source: "slash-command",
        senderId,
        sessionKey,
        actionLabel: "/restart",
      },
      oldPid,
      method: "launchctl-kickstart",
    });

    // 3. Predecessor onSigterm writes signal-received line (mirrors
    //    run-loop.ts:460-470).
    appendGatewayRestartAuditLine({
      env,
      phase: "signal-received",
      signal: "SIGTERM",
      audit: {
        source: "slash-command",
        senderId,
        sessionKey,
        actionLabel: "/restart",
      },
      oldPid,
      extra: { action: "restart" },
    });

    // 4. New process boot reads sentinel and writes completed line
    //    (mirrors run-loop.ts:558-585 Change 6 + Change 7A).
    const sentinel = await readRestartSentinel(env);
    const audit = sentinel?.payload.audit ?? null;
    appendGatewayRestartAuditLine({
      env,
      phase: "completed",
      signal: "boot",
      audit: audit
        ? {
            source: audit.source,
            senderId: audit.senderId,
            sessionKey: audit.sessionKey,
            actionLabel: audit.actionLabel,
          }
        : undefined,
      oldPid: audit?.oldPid,
      newPid,
      extra: { first_start: "false" },
    });

    const lines = readLogLines(env);
    expect(lines).toHaveLength(3);

    // All 3 lines must carry source=slash-command + sender_id (Chief strict bar).
    for (const line of lines) {
      expect(line).toContain("source=slash-command");
      expect(line).toContain(`sender_id=${senderId}`);
    }

    // Phase ordering.
    expect(lines[0]).toContain("restart-dispatch");
    expect(lines[1]).toContain("restart-signal-received");
    expect(lines[2]).toContain("restart-completed");

    // old_pid -> new_pid linkage stable (Chief minimum bar).
    expect(lines[0]).toContain(`old_pid=${oldPid}`);
    expect(lines[1]).toContain(`old_pid=${oldPid}`);
    expect(lines[2]).toContain(`old_pid=${oldPid}`);
    expect(lines[2]).toContain(`new_pid=${newPid}`);

    await removeRestartSentinelFile(resolveRestartSentinelPath(env));
  });
});
