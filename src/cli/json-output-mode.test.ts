import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { loggingState } from "../logging/state.js";
import {
  applyResolvedCommandOutputMode as resolveMode,
  hasJsonOutputFlag,
  isJsonOutputModeActive as isJson,
  withConsoleLogsRoutedToStderr as withTemporary,
  withConsoleLogsRoutedToStderrForJson as withJson,
} from "./json-output-mode.js";

const argv = (...args: string[]) => ["node", "openclaw", ...args];
const configArgs = argv("config", "set", "x", "1", "--json");
function capture(stream: NodeJS.WriteStream) {
  const spy = vi.spyOn(stream, "write").mockImplementation(() => true);
  return { spy, text: () => spy.mock.calls.map(([chunk]) => String(chunk)).join("") };
}

const originalRouting = {
  forceConsoleToStderr: loggingState.forceConsoleToStderr,
  earlyConsoleRoutingRestore: loggingState.earlyConsoleRoutingRestore,
};
beforeEach(() => {
  vi.stubEnv("OPENCLAW_SUPPRESS_NOTES", "");
  Object.assign(loggingState, { forceConsoleToStderr: false, earlyConsoleRoutingRestore: null });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.assign(loggingState, originalRouting);
});

it("detects json output flags before argv terminators", () => {
  expect(hasJsonOutputFlag(argv("nodes", "list", "--json"))).toBe(true);
  expect(hasJsonOutputFlag(argv("nodes", "list", "--json=true"))).toBe(true);
  expect(hasJsonOutputFlag(argv("models", "--status-json"))).toBe(false);
  expect(hasJsonOutputFlag(argv("nodes", "--", "--json"))).toBe(false);
});

it("keeps Doctor warnings on stderr and JSON stdout parseable", async () => {
  const stdout = capture(process.stdout),
    stderr = capture(process.stderr);
  const message = "- Agent main database ...: synthetic failure";
  const report = { ok: true, findings: [] };
  await withJson(argv("doctor", "--lint", "--json"), async () => {
    note(message, "Doctor warnings");
    process.stdout.write(`${JSON.stringify(report)}\n`);
  });
  expect(stdout.text()).toBe(`${JSON.stringify(report)}\n`);
  expect(stderr.text()).toContain("Doctor warnings");
  expect(stderr.text()).toContain(message);
});

it.each([
  { args: configArgs, machineOutput: false },
  { args: argv("models", "aliases", "list", "--plain"), machineOutput: true },
])("refines machine output=$machineOutput", async ({ args, machineOutput }) => {
  const stdout = capture(process.stdout),
    stderr = capture(process.stderr);
  expect(isJson(args)).toBe(false);
  await withJson(
    args,
    async () => {
      resolveMode(false, machineOutput);
      expect(isJson(args)).toBe(false);
      note("Updated gateway.port.", "Config updated");
    },
    { machineOutput },
  );
  const output = machineOutput ? stderr : stdout;
  expect(output.text()).toContain("Config updated");
  expect(output.text()).toContain("Updated gateway.port.");
  expect((machineOutput ? stdout : stderr).spy).not.toHaveBeenCalled();
});

it.each(["temporary-first", "json-first"])(
  "retains overlapping stderr scopes (%s)",
  async (order) => {
    const resume = Promise.withResolvers<void>();
    let temporary = order === "temporary-first" ? withTemporary(() => resume.promise) : undefined;
    try {
      await withJson(["--json"], async () => {
        temporary ??= withTemporary(() => resume.promise);
        resolveMode(false);
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
  await withTemporary(async () => {
    await withJson(["--json"], async () => {}, { retainRoutingUntilProcessExit: true });
    expect(loggingState.forceConsoleToStderr).toBe(true);
  });
  expect(loggingState.forceConsoleToStderr).toBe(true);
});
