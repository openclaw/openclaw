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

const uid = process.getuid?.() ?? 501;
const foreignUid = uid + 1;
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  if (getuidDescriptor) {
    Object.defineProperty(process, "getuid", getuidDescriptor);
  } else {
    Reflect.deleteProperty(process, "getuid");
  }
});

beforeEach(() => {
  Object.defineProperty(process, "getuid", { configurable: true, value: () => uid });
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
  expect(readDarwinProcessCommand(12, uid)).toEqual({
    argv,
    executable: "/runtime path/node",
    ...(serviceMarker === undefined ? {} : { serviceMarker }),
  });
  expect(readCommand).toHaveBeenCalledExactlyOnceWith(12, {
    environmentKeys: ["OPENCLAW_SERVICE_MARKER"],
  });
});

it("returns no command for proven absence", () => {
  readCommand.mockReturnValue(null);
  expect(readDarwinProcessCommand(12, uid)).toBeUndefined();
});

it.each([
  { observedUid: uid, inspectorUid: uid, exited: false, outcome: "uncertain" },
  { observedUid: undefined, inspectorUid: uid, exited: false, outcome: "uncertain" },
  { observedUid: foreignUid, inspectorUid: undefined, exited: false, outcome: "uncertain" },
  { observedUid: foreignUid, inspectorUid: uid, exited: false, outcome: "foreign" },
  { observedUid: foreignUid, inspectorUid: uid, exited: true, outcome: "gone" },
])(
  "classifies unreadable PID as $outcome ($observedUid/$inspectorUid)",
  ({ observedUid, inspectorUid, exited, outcome }) => {
    Object.defineProperty(process, "getuid", {
      configurable: true,
      value: inspectorUid === undefined ? undefined : () => inspectorUid,
    });
    dead.mockReturnValue(exited);
    const inspect = () => readDarwinProcessCommand(12, observedUid);
    if (outcome === "uncertain") {
      expect(inspect).toThrow("Could not classify PID 12: cannot inspect Darwin arguments");
    } else {
      expect(inspect()).toEqual(
        outcome === "gone" ? undefined : { uid: foreignUid, argvUnavailable: true },
      );
    }
  },
);

it.each(["layout-mismatch", "incomplete", "helper-unavailable"] as const)(
  "does not turn %s into foreign ownership or absence",
  (code) => {
    const error = new ProcSafeError(code, "Inspection unavailable");
    readCommand.mockImplementation(() => {
      throw error;
    });
    dead.mockReturnValue(true);
    expect(() => readDarwinProcessCommand(12, foreignUid)).toThrow(error);
  },
);

it("preserves the native Rosetta refusal", () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  readCommand.mockImplementation(() => {
    throw new ProcSafeError("unsupported-platform", "Rosetta is unsupported");
  });
  expect(() => readDarwinProcessCommand(12, foreignUid)).toThrow(/under Rosetta/);
  expect(dead).not.toHaveBeenCalled();
});
