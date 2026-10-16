import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import {
  streamUpdateFinalizationDoctorOutput,
  UpdateFinalizationOutput,
} from "./update-finalization-output.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  resetLogger();
});

describe("live Doctor child output", () => {
  const heartbeat =
    "SQLite integrity check still running: /private/café/password=fixture-secret (6.0 GiB, 10s elapsed, phase=checking).";
  const observe = (level: "info" | "warn" | "error" | "silent" = "info") => {
    vi.stubEnv("OPENCLAW_LOG_LEVEL", level);
    setLoggerOverride({ level: "silent", consoleLevel: level });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    return { stderr, stdout };
  };

  it.each(["stdout", "stderr"] as const)(
    "frames %s before projecting only known operation facts",
    (stream) => {
      const { stderr, stdout } = observe();
      const output = streamUpdateFinalizationDoctorOutput("pre-plugin");
      const message = JSON.stringify({
        level: "info",
        message: heartbeat,
        chat: "private conversation",
      });
      for (const byte of Buffer.from(message)) {
        output.onOutputChunk(Buffer.from([byte]), stream);
      }
      expect(stderr).not.toHaveBeenCalled();
      output.onOutputChunk(Buffer.from("\npassword=fixture-"), stream);
      output.onOutputChunk(
        Buffer.from(
          "secret\nprivate conversation\nError [SQLITE_BUSY]: private detail\nError [SQLITE_BUSY]: repeated\n",
        ),
        stream,
      );
      output.finish();
      const lines = stderr.mock.calls.map(([line]) => String(line));
      expect(JSON.parse(lines[0]!.slice("[update progress] ".length))).toEqual({
        phase: "pre-plugin",
        stream,
        operation: "sqlite-integrity",
        operationPhase: "checking",
        elapsedMs: 10_000,
        size: "6.0 GiB",
        cancellation: "unknown",
      });
      expect(lines).toHaveLength(1);
      for (const secret of ["fixture", "private", "café", "�"]) {
        expect(lines.join("")).not.toContain(secret);
      }
      expect(stdout).not.toHaveBeenCalled();
    },
  );

  it("discards oversized lines, bounds flooding, and ignores output after settlement", () => {
    vi.useFakeTimers();
    const { stderr } = observe();
    const output = streamUpdateFinalizationDoctorOutput("post-plugin");
    output.onOutputChunk(Buffer.alloc(64 * 1024, "x"), "stderr");
    output.onOutputChunk(Buffer.from(heartbeat + "\n"), "stderr");
    expect(stderr).not.toHaveBeenCalled();
    output.onOutputChunk(Buffer.from((heartbeat + "\n").repeat(1000)), "stderr");
    expect(stderr).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    output.onOutputChunk(Buffer.from(heartbeat.replace("10s", "11s") + "\n"), "stdout");
    expect(stderr).toHaveBeenCalledTimes(2);
    output.finish();
    output.finish();
    vi.advanceTimersByTime(10_000);
    output.onOutputChunk(Buffer.from(heartbeat + "\n"), "stdout");
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(Buffer.byteLength(stderr.mock.calls.flat().join(""))).toBeLessThan(1024);
  });

  it("reports inherited cancellation availability and stops forwarding on cancellation", async () => {
    const { stderr } = observe();
    await withCommandProcessScope(async (stop) => {
      const output = streamUpdateFinalizationDoctorOutput("pre-plugin");
      output.onOutputChunk(Buffer.from(heartbeat + "\n"), "stderr");
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"cancellation":"available"'));
      stop();
      output.onOutputChunk(Buffer.from(heartbeat + "\n"), "stderr");
      output.finish();
      expect(stderr).toHaveBeenCalledTimes(1);
    });
  });

  it("honors quiet logging without changing the child result stream", () => {
    const { stderr, stdout } = observe("silent");
    const output = streamUpdateFinalizationDoctorOutput("pre-plugin");
    output.onOutputChunk(Buffer.from(heartbeat + "\nError [SQLITE_BUSY]: detail\n"), "stdout");
    output.finish();
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("projects nested progress without trusting extra fields or replaying it at completion", () => {
    const { stderr, stdout } = observe();
    const output = streamUpdateFinalizationDoctorOutput();
    const facts = {
      operation: "sqlite-integrity",
      phase: "post-plugin",
      operationPhase: "checking",
      elapsedMs: 30_000,
      size: "6.0 GiB",
      secret: "fixture-private",
      service: "offline",
    };
    const progress = "[update progress] " + JSON.stringify(facts);
    const encoded = JSON.stringify({ level: "info", message: progress });
    output.onOutputChunk(Buffer.from(encoded + "\n"), "stderr");
    output.onOutputChunk(Buffer.from('{"status":"ok"}\n'), "stdout");
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls.flat().join("")).not.toMatch(/fixture-private|offline/u);
    expect(stdout).not.toHaveBeenCalled();
    expect(output.remainingOutput(encoded + "\nWarning retained\n")).toBe("Warning retained\n");
    output.finish();
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it("does not let a broken progress sink interrupt the child's admitted work", () => {
    const { stderr } = observe();
    stderr.mockImplementation(() => {
      throw new Error("output closed");
    });
    const output = streamUpdateFinalizationDoctorOutput("pre-plugin");
    expect(() => output.onOutputChunk(Buffer.from(heartbeat + "\n"), "stderr")).not.toThrow();
    expect(() => output.finish()).not.toThrow();
  });

  it.each(["warn", "error", "silent"] as const)(
    "keeps completion-only advisories at %s while suppressing progress",
    (level) => {
      const { stderr, stdout } = observe(level);
      const output = streamUpdateFinalizationDoctorOutput("pre-plugin");
      output.onOutputChunk(Buffer.from(heartbeat + "\n"), "stderr");
      expect(stderr).not.toHaveBeenCalled();
      output.finish({ stdout: "CRITICAL: only 50 MB free. Free up disk space immediately.\n" });
      expect(stderr).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("CRITICAL: only 50 MB free"),
      );
      expect(stdout).not.toHaveBeenCalled();
    },
  );

  it("retains local completion detail after whole-capture redaction and bounds its display", () => {
    const { stderr, stdout } = observe();
    const output = streamUpdateFinalizationDoctorOutput("pre-plugin");
    const result = {
      stdout:
        "Useful completed repair.\npassword=" +
        "fixture-secret".repeat(2000) +
        "\n" +
        "bounded detail ".repeat(2000),
      stderr: heartbeat + "\nUseful advisory without a result warning.\n",
    };
    output.finish(result);
    output.finish(result);
    expect(stderr).toHaveBeenCalledTimes(2);
    const text = stderr.mock.calls.flat().join("");
    expect(text).toContain("Useful completed repair.");
    expect(text).toContain("Useful advisory without a result warning.");
    expect(text).toContain('"truncated":true');
    expect(text).not.toContain("fixture-secret");
    expect(text).not.toContain("SQLite integrity check still running");
    expect(Buffer.byteLength(text)).toBeLessThan(17 * 1024);
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe("finalization timeout output", () => {
  it("reassembles split UTF-8 and credentials before redacting and bounding excerpts", async () => {
    const output = new UpdateFinalizationOutput();
    await output.run(async () => {
      const capture = streamUpdateFinalizationDoctorOutput("pre-plugin").onOutputChunk;
      const bytes = Buffer.from(
        `completed café\npassword=${"synthetic".repeat(100)}\nactive database-check\n`,
      );
      for (const byte of bytes) {
        capture(Buffer.from([byte]), "stderr");
      }
      capture(Buffer.from("stdout only"), "stdout");
    });
    const snapshot = output.snapshot()!;
    expect(snapshot.stdout).toMatchObject({ excerpt: "stdout only", receivedBytes: 11 });
    expect(snapshot.stderr).toMatchObject({ excerpt: expect.stringContaining("completed café") });
    expect(JSON.stringify(snapshot)).toContain("active database-check");
    expect(JSON.stringify(snapshot)).not.toContain("synthetic");
    expect(JSON.stringify(snapshot)).not.toContain("�");
    assert("excerpt" in snapshot.stderr);
    expect(Buffer.byteLength(snapshot.stderr.excerpt)).toBeLessThanOrEqual(256);
  });

  it.each([false, true])(
    "does not expose multiline private keys (complete=%s)",
    async (complete) => {
      const output = new UpdateFinalizationOutput();
      await output.run(async () => {
        const capture = streamUpdateFinalizationDoctorOutput("pre-plugin").onOutputChunk;
        capture(Buffer.from("-----BEGIN PRIVATE KEY-----\nfixture-private-material\n"), "stdout");
        if (complete) {
          capture(Buffer.from("-----END PRIVATE KEY-----\n"), "stdout");
        }
      });
      expect(JSON.stringify(output.snapshot())).not.toContain("fixture-private-material");
      if (!complete) {
        expect(output.snapshot()?.stdout).toMatchObject({ omitted: "incomplete-private-key" });
      }
    },
  );

  it("omits overflowing text while retaining byte and age facts independently per stream", async () => {
    const output = new UpdateFinalizationOutput();
    await output.run(async () => {
      const capture = streamUpdateFinalizationDoctorOutput("post-plugin").onOutputChunk;
      capture(Buffer.alloc(64 * 1024, "x"), "stdout");
      const boundary = output.snapshot()!.stdout;
      assert("excerpt" in boundary);
      expect(Buffer.byteLength(boundary.excerpt)).toBeLessThanOrEqual(256);
      capture(Buffer.from("password=fixture-private"), "stdout");
      capture(Buffer.from("active validation"), "stderr");
    });
    const snapshot = output.snapshot()!;
    expect(snapshot.stdout).toEqual({
      receivedBytes: 64 * 1024 + Buffer.byteLength("password=fixture-private"),
      lastOutputAgeMs: expect.any(Number),
      omitted: "capture-limit",
    });
    expect(snapshot.stderr).toMatchObject({ excerpt: "active validation" });
  });

  it("isolates commands and phases, including late output and silent commands", async () => {
    const output = new UpdateFinalizationOutput();
    expect(output.snapshot()).toBeUndefined();
    await output.run(async () => {
      const previous = streamUpdateFinalizationDoctorOutput("pre-plugin").onOutputChunk;
      previous(Buffer.from("old output"), "stderr");
      streamUpdateFinalizationDoctorOutput("post-plugin");
      previous(Buffer.from("late output"), "stderr");
      expect(output.snapshot()).toEqual({
        phase: "post-plugin",
        stdout: { receivedBytes: 0, lastOutputAgeMs: null, excerpt: "" },
        stderr: { receivedBytes: 0, lastOutputAgeMs: null, excerpt: "" },
      });
      output.close();
      previous(Buffer.from("closed output"), "stderr");
    });
    expect(output.snapshot()).toBeUndefined();
    expect(new UpdateFinalizationOutput().snapshot()).toBeUndefined();
  });
});
