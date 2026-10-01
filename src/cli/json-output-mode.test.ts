// JSON output mode tests cover CLI JSON mode detection and output handling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { loggingState } from "../logging/state.js";
import {
  applyResolvedCommandOutputMode,
  hasJsonOutputFlag,
  isJsonOutputModeActive,
  withConsoleLogsRoutedToStderrForJson,
} from "./json-output-mode.js";

describe("json output mode", () => {
  const originalForceStderr = loggingState.forceConsoleToStderr;
  const originalEarlyRestore = loggingState.earlyConsoleRoutingRestore;

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_SUPPRESS_NOTES", "");
    loggingState.forceConsoleToStderr = false;
    loggingState.earlyConsoleRoutingRestore = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    loggingState.forceConsoleToStderr = originalForceStderr;
    loggingState.earlyConsoleRoutingRestore = originalEarlyRestore;
  });

  it("detects json output flags before argv terminators", () => {
    expect(hasJsonOutputFlag(["node", "openclaw", "nodes", "list", "--json"])).toBe(true);
    expect(hasJsonOutputFlag(["node", "openclaw", "nodes", "list", "--json=true"])).toBe(true);
    expect(hasJsonOutputFlag(["node", "openclaw", "models", "--status-json"])).toBe(false);
    expect(hasJsonOutputFlag(["node", "openclaw", "nodes", "--", "--json"])).toBe(false);
  });

  it("temporarily routes console logs to stderr while json output is being prepared", async () => {
    const snapshots: boolean[] = [];

    await withConsoleLogsRoutedToStderrForJson(
      ["node", "openclaw", "nodes", "list", "--json"],
      async () => {
        snapshots.push(loggingState.forceConsoleToStderr);
      },
    );

    expect(snapshots).toEqual([true]);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("keeps Doctor warnings on stderr and JSON stdout parseable", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const message = "- Agent main database ...: synthetic failure";
    const report = { ok: true, findings: [] };

    await withConsoleLogsRoutedToStderrForJson(
      ["node", "openclaw", "doctor", "--lint", "--json"],
      async () => {
        note(message, "Doctor warnings");
        process.stdout.write(`${JSON.stringify(report)}\n`);
      },
    );

    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toBe(`${JSON.stringify(report)}\n`);
    expect(JSON.parse(output)).toEqual(report);
    const warnings = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(warnings).toContain("Doctor warnings");
    expect(warnings).toContain(message);
  });

  it("leaves existing stderr routing enabled after json output preparation", async () => {
    loggingState.forceConsoleToStderr = true;

    await withConsoleLogsRoutedToStderrForJson(
      ["node", "openclaw", "nodes", "list", "--json"],
      async () => {
        expect(loggingState.forceConsoleToStderr).toBe(true);
      },
    );

    expect(loggingState.forceConsoleToStderr).toBe(true);
  });

  it("restores stdout routing when command metadata marks --json as parse-only", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await withConsoleLogsRoutedToStderrForJson(
      ["node", "openclaw", "config", "set", "gateway.port", "18789", "--json"],
      async () => {
        expect(loggingState.forceConsoleToStderr).toBe(true);
        applyResolvedCommandOutputMode(false);
        expect(loggingState.forceConsoleToStderr).toBe(false);
        expect(
          isJsonOutputModeActive(["node", "openclaw", "config", "set", "x", "1", "--json"]),
        ).toBe(false);
        note("Updated gateway.port.", "Config updated");
      },
    );

    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("Config updated");
    expect(output).toContain("Updated gateway.port.");
    expect(stderr).not.toHaveBeenCalled();
  });

  it("does not treat config set's parser alias as JSON output before Commander resolves it", () => {
    expect(isJsonOutputModeActive(["node", "openclaw", "config", "set", "x", "1", "--json"])).toBe(
      false,
    );
  });

  it("preserves inherited stderr routing when resolved metadata is parse-only", async () => {
    loggingState.forceConsoleToStderr = true;

    await withConsoleLogsRoutedToStderrForJson(
      ["node", "openclaw", "config", "set", "gateway.port", "18789", "--json"],
      async () => {
        applyResolvedCommandOutputMode(false);
        expect(loggingState.forceConsoleToStderr).toBe(true);
      },
    );
  });

  it("retains stderr routing through preaction for plain machine output", async () => {
    await withConsoleLogsRoutedToStderrForJson(
      ["node", "openclaw", "models", "aliases", "list", "--plain"],
      async () => {
        expect(loggingState.forceConsoleToStderr).toBe(true);
        applyResolvedCommandOutputMode(false, true);
        expect(loggingState.forceConsoleToStderr).toBe(true);
        expect(
          isJsonOutputModeActive(["node", "openclaw", "models", "aliases", "list", "--plain"]),
        ).toBe(false);
      },
      { machineOutput: true },
    );
  });

  it("still restores stdout when preaction resolves neither JSON nor plain machine output", async () => {
    await withConsoleLogsRoutedToStderrForJson(
      ["node", "openclaw", "models", "aliases", "list", "--plain"],
      async () => {
        applyResolvedCommandOutputMode(false);
        expect(loggingState.forceConsoleToStderr).toBe(false);
      },
      { machineOutput: true },
    );
  });
});
