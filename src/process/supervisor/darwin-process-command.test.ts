import { ProcSafeError } from "@openclaw/proc-safe/errors";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { readCommand, dead } = vi.hoisted(() => ({ readCommand: vi.fn(), dead: vi.fn() }));
vi.mock("@openclaw/proc-safe/inspect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/inspect")>()),
  readProcessCommand: readCommand,
}));
vi.mock("../../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({ debug: vi.fn() }),
}));
vi.mock("../../shared/pid-alive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/pid-alive.js")>()),
  isPidDefinitelyDead: dead,
}));
import { readDarwinProcessCommand } from "./darwin-process-command.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
});

beforeEach(() => {
  dead.mockReset().mockReturnValue(false);
  readCommand.mockReset().mockImplementation(() => {
    throw new ProcSafeError("access-denied", "Process arguments denied");
  });
});

it.each([
  { argv: ["node", "/app with spaces/openclaw.mjs", "", "doctor"], serviceMarker: undefined },
  { argv: ["openclaw-gateway", "", "", ""], serviceMarker: "" },
  { argv: ["node", "dist/index.js"], serviceMarker: "openclaw" },
])("preserves exact argv $argv and selects only the service marker", ({ argv, serviceMarker }) => {
  readCommand.mockReturnValue({
    executable: "/runtime path/node",
    argv: Object.freeze(argv),
    environment: serviceMarker === undefined ? {} : { OPENCLAW_SERVICE_MARKER: serviceMarker },
  });
  expect(readDarwinProcessCommand(12, "same")).toEqual({
    argv,
    executable: "/runtime path/node",
    ...(serviceMarker === undefined ? {} : { serviceMarker }),
  });
  expect(readCommand).toHaveBeenCalledExactlyOnceWith(12, {
    environmentKeys: ["OPENCLAW_SERVICE_MARKER"],
  });
});

it.each([
  { executable: "/bin/zsh", argv: ["/bin/zsh", "-c", "sleep 30"], unknown: false },
  { executable: "/opt/homebrew/bin/node", argv: ["node", "/app/dist/index.js"], unknown: true },
  { executable: "/usr/local/bin/bun", argv: ["bun", "run", "start"], unknown: true },
  { executable: "/bin/sleep", argv: ["/Users/me/.local/bin/tsx", "app.ts"], unknown: true },
])("reads $executable argv when Darwin omits its environment", ({ executable, argv, unknown }) => {
  // macOS 27 ends hardened executables' argument images right after argv.
  const incomplete = new ProcSafeError("incomplete", "unterminated Darwin environment");
  readCommand.mockImplementation((_pid: number, options?: { environmentKeys?: string[] }) => {
    if (options?.environmentKeys?.length) {
      throw incomplete;
    }
    return { executable, argv: Object.freeze(argv), environment: {} };
  });
  if (unknown) {
    expect(() => readDarwinProcessCommand(12, "same")).toThrow(incomplete);
  } else {
    expect(readDarwinProcessCommand(12, "same")).toEqual({ argv, executable });
  }
  expect(readDarwinProcessCommand(12, "same", { serviceMarker: false })).toEqual({
    argv,
    executable,
  });
});

it("returns no command for proven absence", () => {
  readCommand.mockReturnValue(null);
  expect(readDarwinProcessCommand(12, "same")).toBeUndefined();
});

it.each([
  { owner: "same", exited: false, outcome: "uncertain" },
  { owner: "unknown", exited: false, outcome: "uncertain" },
  { owner: undefined, exited: false, outcome: "uncertain" },
  { owner: "different", exited: false, outcome: "foreign" },
  { owner: "different", exited: true, outcome: "gone" },
] as const)("classifies unreadable PID as $outcome ($owner)", ({ owner, exited, outcome }) => {
  dead.mockReturnValue(exited);
  const inspect = () => readDarwinProcessCommand(12, owner);
  if (outcome === "uncertain") {
    expect(inspect).toThrow("Could not classify PID 12: cannot inspect Darwin arguments");
  } else {
    expect(inspect()).toEqual(
      outcome === "gone" ? undefined : { owner: "different", argvUnavailable: true },
    );
  }
});

it.each(["layout-mismatch", "incomplete", "helper-unavailable"] as const)(
  "does not turn %s into foreign ownership or absence",
  (code) => {
    const error = new ProcSafeError(code, "Inspection unavailable");
    readCommand.mockImplementation(() => {
      throw error;
    });
    dead.mockReturnValue(true);
    expect(() => readDarwinProcessCommand(12, "different")).toThrow(error);
  },
);

it("preserves the native Rosetta refusal", () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  readCommand.mockImplementation(() => {
    throw new ProcSafeError("unsupported-platform", "Rosetta is unsupported");
  });
  expect(() => readDarwinProcessCommand(12, "different")).toThrow(/under Rosetta/);
  expect(dead).not.toHaveBeenCalled();
});
