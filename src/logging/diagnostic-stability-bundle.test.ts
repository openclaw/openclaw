import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { resetFatalErrorHooksForTest, runFatalErrorHooks } from "../infra/fatal-error-hooks.js";
import {
  installDiagnosticStabilityFatalHook,
  readDiagnosticStabilityBundleFileSync,
  readLatestDiagnosticStabilityBundleSync,
  resetDiagnosticStabilityBundleForTest,
  writeDiagnosticStabilityBundleSync,
  type DiagnosticStabilityBundle,
} from "./diagnostic-stability-bundle.js";
import {
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "./diagnostic-stability.js";

describe("diagnostic stability bundles", () => {
  let tempDir: string;

  function resetStabilityBundleTestState(): void {
    resetDiagnosticEventsForTest();
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticStabilityBundleForTest();
    resetFatalErrorHooksForTest();
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-stability-bundle-"));
    resetStabilityBundleTestState();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetStabilityBundleTestState();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function readBundle(file: string): DiagnosticStabilityBundle {
    return JSON.parse(fs.readFileSync(file, "utf8")) as DiagnosticStabilityBundle;
  }

  it("writes a payload-free bundle with safe failure metadata", () => {
    startDiagnosticStabilityRecorder();
    emitDiagnosticEvent({
      type: "webhook.error",
      channel: "telegram",
      chatId: "chat-secret",
      error: "raw diagnostic error with message body",
    });
    emitDiagnosticEvent({
      type: "payload.large",
      surface: "gateway.http.json",
      action: "rejected",
      bytes: 2048,
      limitBytes: 1024,
      reason: "json_body_limit",
    });

    const error = Object.assign(new Error("contains secret message"), { code: "ERR_TEST" });
    const result = writeDiagnosticStabilityBundleSync({
      reason: "gateway.restart_startup_failed",
      error,
      stateDir: tempDir,
      now: new Date("2026-04-22T12:00:00.000Z"),
    });

    expect(result.status).toBe("written");
    const file = result.status === "written" ? result.path : "";
    const bundle = readBundle(file);
    const raw = fs.readFileSync(file, "utf8");

    expect(bundle).toMatchObject({
      version: 1,
      generatedAt: "2026-04-22T12:00:00.000Z",
      reason: "gateway.restart_startup_failed",
      error: {
        name: "Error",
        code: "ERR_TEST",
      },
      host: {
        hostname: "<redacted-hostname>",
      },
      snapshot: {
        count: 2,
      },
    });
    expect(bundle.snapshot.events[0]).toMatchObject({
      type: "webhook.error",
      channel: "telegram",
    });
    expect(bundle.snapshot.events[0]).not.toHaveProperty("chatId");
    expect(bundle.snapshot.events[0]).not.toHaveProperty("error");
    expect(raw).not.toContain("chat-secret");
    expect(raw).not.toContain("message body");
    expect(raw).not.toContain("contains secret message");
    expect(raw).not.toContain(os.hostname());
  });

  it("skips empty recorder snapshots by default", () => {
    const result = writeDiagnosticStabilityBundleSync({
      reason: "uncaught_exception",
      stateDir: tempDir,
    });

    expect(result).toEqual({ status: "skipped", reason: "empty" });
    expect(fs.existsSync(path.join(tempDir, "logs", "stability"))).toBe(false);
  });

  it("registers a fatal hook only while installed", () => {
    startDiagnosticStabilityRecorder();
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });
    installDiagnosticStabilityFatalHook({ stateDir: tempDir });

    const messages = runFatalErrorHooks({
      reason: "fatal_unhandled_rejection",
      error: Object.assign(new Error("raw text"), { code: "ERR_OUT_OF_MEMORY" }),
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("wrote stability bundle:");
    expect(messages[0]).toContain(tempDir);

    resetDiagnosticStabilityBundleForTest();
    expect(runFatalErrorHooks({ reason: "uncaught_exception" })).toEqual([]);
  });

  it("retains only the newest bundle files", () => {
    startDiagnosticStabilityRecorder();
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });

    for (let index = 0; index < 4; index += 1) {
      const result = writeDiagnosticStabilityBundleSync({
        reason: "gateway.restart_respawn_failed",
        stateDir: tempDir,
        now: new Date(`2026-04-22T12:00:0${index}.000Z`),
        retention: 2,
      });
      expect(result.status).toBe("written");
    }

    const bundleDir = path.join(tempDir, "logs", "stability");
    const files = fs.readdirSync(bundleDir).toSorted();
    expect(files).toHaveLength(2);
    expect(files[0]).toContain("12-00-02");
    expect(files[1]).toContain("12-00-03");
  });

  it("reads the newest retained bundle", () => {
    startDiagnosticStabilityRecorder();
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });

    const older = writeDiagnosticStabilityBundleSync({
      reason: "gateway.restart_startup_failed",
      stateDir: tempDir,
      now: new Date("2026-04-22T12:00:00.000Z"),
    });
    const newer = writeDiagnosticStabilityBundleSync({
      reason: "gateway.restart_respawn_failed",
      stateDir: tempDir,
      now: new Date("2026-04-22T12:00:01.000Z"),
    });

    expect(older.status).toBe("written");
    expect(newer.status).toBe("written");

    const latest = readLatestDiagnosticStabilityBundleSync({ stateDir: tempDir });

    expect(latest.status).toBe("found");
    expect(latest.status === "found" ? latest.path : "").toContain("12-00-01");
    expect(latest.status === "found" ? latest.bundle.reason : "").toBe(
      "gateway.restart_respawn_failed",
    );
  });

  it("rejects malformed bundle files", () => {
    const file = path.join(tempDir, "invalid.json");
    fs.writeFileSync(file, "{}\n", "utf8");

    const result = readDiagnosticStabilityBundleFileSync(file);

    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? String(result.error) : "").toContain(
      "Unsupported stability bundle version",
    );
  });

  it("rejects malformed bundle snapshots before returning them", () => {
    const baseBundle = {
      version: 1,
      generatedAt: "2026-04-22T12:00:00.000Z",
      reason: "gateway.restart_startup_failed",
      process: {
        pid: 123,
        platform: "darwin",
        arch: "arm64",
        node: "24.14.1",
        uptimeMs: 1000,
      },
      host: {
        hostname: "<redacted-hostname>",
      },
      snapshot: {
        generatedAt: "2026-04-22T12:00:00.000Z",
        capacity: 1000,
        count: 1,
        dropped: 0,
        events: [{ seq: 1, ts: 1, type: "webhook.received" }],
        summary: { byType: { "webhook.received": 1 } },
      },
    };
    const cases = [
      {
        name: "malformed-event",
        bundle: {
          ...baseBundle,
          snapshot: {
            ...baseBundle.snapshot,
            events: [{ type: "webhook.received", ts: 1 }],
          },
        },
        error: "snapshot.events[0].seq",
      },
      {
        name: "null-summary",
        bundle: {
          ...baseBundle,
          snapshot: {
            ...baseBundle.snapshot,
            summary: null,
          },
        },
        error: "snapshot.summary",
      },
    ];

    for (const testCase of cases) {
      const file = path.join(tempDir, `${testCase.name}.json`);
      fs.writeFileSync(file, `${JSON.stringify(testCase.bundle, null, 2)}\n`, "utf8");

      const result = readDiagnosticStabilityBundleFileSync(file);

      expect(result.status).toBe("failed");
      expect(result.status === "failed" ? String(result.error) : "").toContain(testCase.error);
    }
  });
});
