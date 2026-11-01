import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { isUpdateAdmissionAuthorityEnvKey } from "../infra/update-admission-contract.js";
import { resetLogger } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { defaultRuntime } from "../runtime.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { tryRunUpdateAdmissionBeforeStartup } from "./run-main-update-admission.js";

// The real command's inspection is covered by update-command-admit tests and the published-driver cell.
// mock-isolation: emits the SQLite budget debug line admission logs mid-inspection, then the verdict.
vi.mock("./update-cli/update-command-admit.js", () => ({
  updateAdmitCommand: vi.fn(async () => {
    createSubsystemLogger("state/sqlite").debug(
      "SQLite read-only snapshot for /fixture/state/openclaw.sqlite: 1.4 MiB, budget 302 seconds",
    );
    defaultRuntime.writeJson({ protocol: 1, verdict: "admit" });
  }),
}));

vi.mock("./update-cli/update-command-preflight.js", () => ({
  updatePreflightCommand: vi.fn(async () => {
    createSubsystemLogger("state/sqlite").debug("preflight snapshot inspection");
    defaultRuntime.writeJson({ protocol: 1, mode: "preflight", status: "ready" });
  }),
}));

const initialExitCode = process.exitCode;
const initialRouting = loggingState.forceConsoleToStderr;

afterEach(() => {
  process.exitCode = initialExitCode;
  loggingState.forceConsoleToStderr = initialRouting;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetLogger();
});

it.each(["admit", "preflight"] as const)(
  "keeps $0 protocol stdout separate from raised-level logs",
  async (command) => {
    for (const key of Object.keys(process.env)) {
      if (isUpdateAdmissionAuthorityEnvKey(key)) {
        vi.stubEnv(key, undefined);
      }
    }
    vi.stubEnv("OPENCLAW_PROFILE", undefined);
    vi.stubEnv("OPENCLAW_LOG_LEVEL", "debug");
    let stdout = "";
    let stderr = "";
    const toStdout = (...args: unknown[]) => {
      stdout += `${args.join(" ")}\n`;
    };
    const toStderr = (...args: unknown[]) => {
      stderr += `${args.join(" ")}\n`;
    };
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    // Subsystem logging writes through the console (or its saved raw sink), not the stream spies.
    vi.spyOn(console, "log").mockImplementation(toStdout);
    vi.spyOn(console, "error").mockImplementation(toStderr);
    if (loggingState.rawConsole) {
      vi.spyOn(loggingState.rawConsole, "log").mockImplementation(toStdout);
      vi.spyOn(loggingState.rawConsole, "error").mockImplementation(toStderr);
    }
    loggingState.forceConsoleToStderr = false;
    resetLogger();
    const contextPath = path.resolve("/fixture/admission-context.json");

    await expect(
      tryRunUpdateAdmissionBeforeStartup(
        resolveCliArgvInvocation([
          "node",
          "openclaw",
          "update",
          command,
          ...(command === "admit" ? ["--context", contextPath] : ["--json"]),
        ]),
      ),
    ).resolves.toBe(true);

    expect(JSON.parse(stdout)).toEqual(
      command === "admit"
        ? { protocol: 1, verdict: "admit" }
        : { protocol: 1, mode: "preflight", status: "ready" },
    );
    // CI colorizes the subsystem prefix.
    expect(stripAnsi(stderr)).toContain(
      command === "admit"
        ? "[state/sqlite] SQLite read-only snapshot for /fixture/"
        : "[state/sqlite] preflight snapshot inspection",
    );
    expect(process.exitCode).toBe(initialExitCode);
  },
);
