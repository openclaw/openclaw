// JSON output mode tests cover CLI JSON mode detection and output handling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { loggingState } from "../logging/state.js";
import {
  applyResolvedCommandOutputMode,
  hasJsonOutputFlag,
  isJsonOutputModeActive,
  withConsoleLogsRoutedToStderr,
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

  it.each(["temporary-first", "json-first"])(
    "retains temporary stderr routing across JSON refinement and release (%s)",
    async (order) => {
      const resume = Promise.withResolvers<void>();
      let temporary: Promise<void> | undefined;
      const startTemporary = () => {
        temporary = withConsoleLogsRoutedToStderr(() => resume.promise);
      };
      try {
        if (order === "temporary-first") {
          startTemporary();
        }
        await withConsoleLogsRoutedToStderrForJson(["--json"], async () => {
          if (order === "json-first") {
            startTemporary();
          }
          applyResolvedCommandOutputMode(false);
          expect(loggingState.forceConsoleToStderr).toBe(true);
        });
        expect(loggingState.forceConsoleToStderr).toBe(true);
        resume.resolve();
        await temporary;
        expect(loggingState.forceConsoleToStderr).toBe(false);
      } finally {
        resume.resolve();
        await temporary;
      }
    },
  );

  it("preserves JSON routing retained until exit when a temporary scope finishes", async () => {
    await withConsoleLogsRoutedToStderr(async () => {
      await withConsoleLogsRoutedToStderrForJson(["--json"], async () => {}, {
        retainRoutingUntilProcessExit: true,
      });
      expect(loggingState.forceConsoleToStderr).toBe(true);
    });
    expect(loggingState.forceConsoleToStderr).toBe(true);
  });
});
