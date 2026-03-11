import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  consumeRestartSentinel,
  formatRestartSentinelInternalContext,
  formatRestartSentinelMessage,
  formatRestartSentinelUserMessage,
  readRestartSentinel,
  resolveRestartSentinelPath,
  summarizeRestartSentinel,
  trimLogTail,
  writeRestartSentinel,
} from "./restart-sentinel.js";

describe("restart sentinel", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempDir: string;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sentinel-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
  });

  afterEach(async () => {
    envSnapshot.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("writes and consumes a sentinel", async () => {
    const payload = {
      kind: "update" as const,
      status: "ok" as const,
      ts: Date.now(),
      sessionKey: "agent:main:whatsapp:dm:+15555550123",
      stats: { mode: "git" },
    };
    const filePath = await writeRestartSentinel(payload);
    expect(filePath).toBe(resolveRestartSentinelPath());

    const read = await readRestartSentinel();
    expect(read?.payload.kind).toBe("update");

    const consumed = await consumeRestartSentinel();
    expect(consumed?.payload.sessionKey).toBe(payload.sessionKey);

    const empty = await readRestartSentinel();
    expect(empty).toBeNull();
  });

  it("drops invalid sentinel payloads", async () => {
    const filePath = resolveRestartSentinelPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "not-json", "utf-8");

    const read = await readRestartSentinel();
    expect(read).toBeNull();

    await expect(fs.stat(filePath)).rejects.toThrow();
  });

  it("drops structurally invalid sentinel payloads", async () => {
    const filePath = resolveRestartSentinelPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ version: 2, payload: null }), "utf-8");

    await expect(readRestartSentinel()).resolves.toBeNull();
    await expect(fs.stat(filePath)).rejects.toThrow();
  });

  it("formatRestartSentinelMessage uses custom message when present", () => {
    const payload = {
      kind: "config-apply" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "Config updated successfully",
    };
    expect(formatRestartSentinelMessage(payload)).toBe("Config updated successfully");
  });

  it("formatRestartSentinelMessage falls back to summary when no message", () => {
    const payload = {
      kind: "update" as const,
      status: "ok" as const,
      ts: Date.now(),
      stats: { mode: "git" },
    };
    const result = formatRestartSentinelMessage(payload);
    expect(result).toContain("Gateway restart");
    expect(result).toContain("update");
    expect(result).toContain("ok");
  });

  it("formatRestartSentinelMessage falls back to summary for blank message", () => {
    const payload = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "   ",
    };
    const result = formatRestartSentinelMessage(payload);
    expect(result).toContain("Gateway restart");
  });

  it("formats summary, distinct reason, and doctor hint together", () => {
    const payload = {
      kind: "config-patch" as const,
      status: "error" as const,
      ts: Date.now(),
      message: "Patch failed",
      doctorHint: "Run openclaw doctor",
      stats: { mode: "patch", reason: "validation failed" },
    };

    expect(formatRestartSentinelMessage(payload)).toBe(
      [
        "Gateway restart config-patch error (patch)",
        "Patch failed",
        "Reason: validation failed",
        "Run openclaw doctor",
      ].join("\n"),
    );
  });

  it("trims log tails", () => {
    const text = "a".repeat(9000);
    const trimmed = trimLogTail(text, 8000);
    expect(trimmed?.length).toBeLessThanOrEqual(8001);
    expect(trimmed?.startsWith("…")).toBe(true);
  });

  it("formats restart messages without volatile timestamps", () => {
    const payloadA = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: 100,
      message: "Restart requested by /restart",
      stats: { mode: "gateway.restart", reason: "/restart" },
    };
    const payloadB = { ...payloadA, ts: 200 };
    const textA = formatRestartSentinelMessage(payloadA);
    const textB = formatRestartSentinelMessage(payloadB);
    expect(textA).toBe(textB);
    expect(textA).toContain("Gateway restart restart ok");
    expect(textA).not.toContain('"ts"');
  });

  it("summarizes restart payloads and trims log tails without trailing whitespace", () => {
    expect(
      summarizeRestartSentinel({
        kind: "update",
        status: "skipped",
        ts: 1,
      }),
    ).toBe("Gateway restart update skipped");
    expect(trimLogTail("hello\n")).toBe("hello");
    expect(trimLogTail(undefined)).toBeNull();
  });
});

describe("formatRestartSentinelUserMessage", () => {
  it("returns generic success message regardless of note (note is internal only)", () => {
    // The `note`/`message` field is an operator annotation — it must never be surfaced
    // directly to the user. Only the agent (via internalContext) should see it.
    const payload = {
      kind: "config-patch" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "testing restart sentinel",
      doctorHint: "Run: openclaw doctor --non-interactive",
    };
    const result = formatRestartSentinelUserMessage(payload);
    expect(result).toBe("Gateway restarted successfully.");
    expect(result).not.toContain("testing restart sentinel");
    expect(result).not.toContain("config-patch");
    expect(result).not.toContain("doctor");
  });

  it("returns generic success message when no note", () => {
    const payload = {
      kind: "update" as const,
      status: "ok" as const,
      ts: Date.now(),
    };
    expect(formatRestartSentinelUserMessage(payload)).toBe("Gateway restarted successfully.");
  });

  it("returns generic failure message for error status (note is internal only)", () => {
    // Raw note must not appear in user-facing fallback even on error.
    const payload = {
      kind: "config-apply" as const,
      status: "error" as const,
      ts: Date.now(),
      message: "disk full",
    };
    const result = formatRestartSentinelUserMessage(payload);
    expect(result).toBe("Gateway restart failed.");
    expect(result).not.toContain("disk full");
  });

  it("returns generic failure message for error without note", () => {
    const payload = {
      kind: "restart" as const,
      status: "error" as const,
      ts: Date.now(),
    };
    expect(formatRestartSentinelUserMessage(payload)).toBe("Gateway restart failed.");
  });

  it("never includes doctorHint", () => {
    const payload = {
      kind: "config-patch" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "applied config",
      doctorHint: "Run: openclaw doctor --non-interactive",
    };
    expect(formatRestartSentinelUserMessage(payload)).not.toContain("doctor");
    expect(formatRestartSentinelUserMessage(payload)).not.toContain("openclaw");
  });
});

describe("formatRestartSentinelInternalContext", () => {
  it("includes kind, status, note, and doctorHint", () => {
    const payload = {
      kind: "config-patch" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "testing restart sentinel",
      doctorHint: "Run: openclaw doctor --non-interactive",
      stats: { mode: "gateway.config-patch", reason: "discovery.mdns.mode changed" },
    };
    const result = formatRestartSentinelInternalContext(payload);
    expect(result).toContain("kind: config-patch");
    expect(result).toContain("status: ok");
    expect(result).toContain("note: testing restart sentinel");
    expect(result).toContain("hint: Run: openclaw doctor");
    expect(result).toContain("mode: gateway.config-patch");
    expect(result).toContain("reason: discovery.mdns.mode changed");
    expect(result).toContain("internal");
  });

  it("omits empty optional fields", () => {
    const payload = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: Date.now(),
    };
    const result = formatRestartSentinelInternalContext(payload);
    expect(result).not.toContain("note:");
    expect(result).not.toContain("hint:");
    expect(result).not.toContain("reason:");
    expect(result).not.toContain("mode:");
  });

  it("omits reason when it duplicates note", () => {
    const note = "Applying config changes";
    const payload = {
      kind: "config-apply" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: note,
      stats: { reason: note },
    };
    const result = formatRestartSentinelInternalContext(payload);
    const noteOccurrences = result.split(note).length - 1;
    expect(noteOccurrences).toBe(1);
  });
});

describe("restart sentinel message dedup", () => {
  it("omits duplicate Reason: line when stats.reason matches message", () => {
    const payload = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "Applying config changes",
      stats: { mode: "gateway.restart", reason: "Applying config changes" },
    };
    const result = formatRestartSentinelMessage(payload);
    // The message text should appear exactly once, not duplicated as "Reason: ..."
    const occurrences = result.split("Applying config changes").length - 1;
    expect(occurrences).toBe(1);
    expect(result).not.toContain("Reason:");
  });

  it("keeps Reason: line when stats.reason differs from message", () => {
    const payload = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "Restart requested by /restart",
      stats: { mode: "gateway.restart", reason: "/restart" },
    };
    const result = formatRestartSentinelMessage(payload);
    expect(result).toContain("Restart requested by /restart");
    expect(result).toContain("Reason: /restart");
  });

  it("formats the non-interactive doctor command", () => {
    expect(formatDoctorNonInteractiveHint({ PATH: "/usr/bin:/bin" })).toContain(
      "openclaw doctor --non-interactive",
    );
  });
});
