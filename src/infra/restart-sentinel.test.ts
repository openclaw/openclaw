import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  consumeFinalizedRestartSentinel,
  consumeRestartSentinel,
  finalizeRestartSentinelForCompletedRestart,
  formatRestartSentinelMessage,
  isFinalRestartSentinelStatus,
  readRestartSentinel,
  resolveRestartSentinelPath,
  transitionRestartSentinelStatus,
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

  it("only consumes finalized sentinels", async () => {
    await writeRestartSentinel({
      kind: "restart",
      status: "pending",
      ts: Date.now(),
    });

    expect(await consumeFinalizedRestartSentinel()).toBeNull();
    expect((await readRestartSentinel())?.payload.status).toBe("pending");

    await transitionRestartSentinelStatus("ok", {
      allowedCurrentStatuses: ["pending"],
    });

    const consumed = await consumeFinalizedRestartSentinel();
    expect(consumed?.payload.status).toBe("ok");
    expect(await readRestartSentinel()).toBeNull();
  });

  it("finalizes only fresh in-progress restart sentinels", async () => {
    await writeRestartSentinel({
      kind: "restart",
      status: "in-progress",
      ts: Date.now(),
    });

    const finalized = await finalizeRestartSentinelForCompletedRestart();
    expect(finalized?.payload.status).toBe("ok");

    await writeRestartSentinel({
      kind: "restart",
      status: "in-progress",
      ts: Date.now() - 10_000,
    });

    const stale = await finalizeRestartSentinelForCompletedRestart(process.env, 100);
    expect(stale).toBeNull();
    expect((await readRestartSentinel())?.payload.status).toBe("in-progress");
  });

  it("drops invalid sentinel payloads", async () => {
    const filePath = resolveRestartSentinelPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "not-json", "utf-8");

    const read = await readRestartSentinel();
    expect(read).toBeNull();

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

  it("trims log tails", () => {
    const text = "a".repeat(9000);
    const trimmed = trimLogTail(text, 8000);
    expect(trimmed?.length).toBeLessThanOrEqual(8001);
    expect(trimmed?.startsWith("…")).toBe(true);
  });

  it("reports final sentinel statuses accurately", () => {
    expect(isFinalRestartSentinelStatus("ok")).toBe(true);
    expect(isFinalRestartSentinelStatus("error")).toBe(true);
    expect(isFinalRestartSentinelStatus("skipped")).toBe(true);
    expect(isFinalRestartSentinelStatus("pending")).toBe(false);
    expect(isFinalRestartSentinelStatus("in-progress")).toBe(false);
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
});
