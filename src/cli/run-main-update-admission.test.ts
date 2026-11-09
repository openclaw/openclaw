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
import { updatePreflightCommand } from "./update-cli/update-command-preflight.js";

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

// mock-isolation: exercises early protocol routing without launching the isolated candidate Gateway.
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
  vi.clearAllMocks();
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

it.each([
  { args: ["update", "--timeout", "120", "preflight", "--json"] },
  { args: ["update", "preflight", "--json", "--timeout=120"] },
])("forwards timeout across the early preflight boundary: $args", async ({ args }) => {
  for (const key of Object.keys(process.env)) {
    if (isUpdateAdmissionAuthorityEnvKey(key)) {
      vi.stubEnv(key, undefined);
    }
  }
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  await tryRunUpdateAdmissionBeforeStartup(resolveCliArgvInvocation(["node", "openclaw", ...args]));
  expect(updatePreflightCommand).toHaveBeenCalledWith({ timeout: "120" });
});

it.each(["malformed", "authority"])(
  "returns one unverified receipt for early %s rejection",
  async (mode) => {
    for (const key of Object.keys(process.env)) {
      if (isUpdateAdmissionAuthorityEnvKey(key)) {
        vi.stubEnv(key, undefined);
      }
    }
    if (mode === "authority") {
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    }
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await tryRunUpdateAdmissionBeforeStartup(
      resolveCliArgvInvocation([
        "node",
        "openclaw",
        "update",
        "preflight",
        mode === "malformed" ? "--unknown" : "--json",
      ]),
    );
    expect(updatePreflightCommand).not.toHaveBeenCalled();
    expect(JSON.parse(stdout)).toMatchObject({
      protocol: 1,
      mode: "preflight",
      status: "unverified",
      reason: "preflight-execution-failed",
    });
    expect(process.exitCode).toBe(2);
  },
);
