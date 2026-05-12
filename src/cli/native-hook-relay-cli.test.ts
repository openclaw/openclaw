import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { __testing, registerNativeHookRelay } from "../agents/harness/native-hook-relay.js";
import {
  createReadableTextStream,
  createWritableTextBuffer,
  runNativeHookRelayCli,
} from "./native-hook-relay-cli.js";

describe("native hook relay CLI", () => {
  it("waits for a direct relay bridge that becomes ready after startup", async () => {
    __testing.clearNativeHookRelaysForTests();
    const relayId = "relay-startup-readiness";
    const callGateway = vi.fn();
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();
    let relay: ReturnType<typeof registerNativeHookRelay> | undefined;

    const registerLater = delay(150).then(() => {
      relay = registerNativeHookRelay({
        provider: "codex",
        relayId,
        sessionId: "session-startup-readiness",
        runId: "run-startup-readiness",
        allowedEvents: ["pre_tool_use"],
      });
    });

    try {
      const exitCode = await runNativeHookRelayCli(
        {
          provider: "codex",
          relayId,
          event: "pre_tool_use",
          timeout: "1000",
        },
        {
          stdin: createReadableTextStream(
            JSON.stringify({
              hook_event_name: "PreToolUse",
              tool_name: "Bash",
              tool_input: { command: "pnpm test" },
            }),
          ),
          stdout,
          stderr,
          callGateway: callGateway as never,
        },
      );

      expect(exitCode).toBe(0);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toBe("");
      expect(callGateway).not.toHaveBeenCalled();
    } finally {
      await registerLater;
      relay?.unregister();
      __testing.clearNativeHookRelaysForTests();
    }
  });

  it("reads Codex hook JSON from stdin and forwards it to the gateway relay", async () => {
    const callGateway = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        event: "pre_tool_use",
        timeout: "1",
      },
      {
        stdin: createReadableTextStream(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "pnpm test" },
          }),
        ),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe("");
    expect(callGateway).toHaveBeenCalledWith({
      method: "nativeHook.invoke",
      params: {
        provider: "codex",
        relayId: "relay-1",
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      },
      timeoutMs: 1,
      scopes: ["operator.admin"],
    });
  });

  it("renders provider-compatible stdout, stderr, and exit code from the gateway response", async () => {
    const callGateway = vi.fn(async () => ({ stdout: "out", stderr: "err", exitCode: 2 }));
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", event: "permission_request", timeout: "1" },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("out");
    expect(stderr.text()).toBe("err");
  });

  it("returns a nonzero code for malformed hook input without touching the gateway", async () => {
    const callGateway = vi.fn();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", event: "pre_tool_use", timeout: "1" },
      {
        stdin: createReadableTextStream("{nope"),
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("failed to read native hook input");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("rejects oversized hook input without touching the gateway", async () => {
    const callGateway = vi.fn();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", event: "post_tool_use", timeout: "1" },
      {
        stdin: createReadableTextStream("x".repeat(1024 * 1024 + 1)),
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("native hook input exceeds");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("fails closed for PreToolUse when the gateway relay is unavailable", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", event: "pre_tool_use", timeout: "1" },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("Native hook relay unavailable"),
      },
    });
    expect(stderr.text()).toContain("native hook relay unavailable");
    expect(stderr.text()).toContain("bridgeRegistry=");
    expect(stderr.text()).toContain("gateway=gateway closed");
    expect(stderr.text()).toContain("remediation=restart the active OpenClaw agent run");
  });

  it("fails closed for PermissionRequest when the gateway relay is unavailable", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", event: "permission_request", timeout: "1" },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: expect.stringContaining("Native hook relay unavailable"),
        },
      },
    });
    expect(stderr.text()).toContain("bridgeRegistry=");
    expect(stderr.text()).toContain("gateway=gateway closed");
  });

  it("keeps PostToolUse unavailable handling observational", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", event: "post_tool_use", timeout: "1" },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("native hook relay unavailable");
  });

  it("keeps before_agent_finalize unavailable handling observational", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", event: "before_agent_finalize", timeout: "1" },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("native hook relay unavailable");
  });
});
