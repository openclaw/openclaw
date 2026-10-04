import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { sysctl, errno, dead } = vi.hoisted(() => ({
  sysctl: vi.fn(),
  errno: vi.fn(),
  dead: vi.fn(),
}));
vi.mock("node:module", () => ({
  createRequire: () => () => ({
    load: () => ({
      func: () => sysctl,
    }),
    errno,
  }),
}));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ debug: vi.fn() }),
}));
vi.mock("../../shared/pid-alive.js", () => ({ isPidDefinitelyDead: dead }));
import { readDarwinProcessCommand } from "./darwin-process-command.js";

let reply: Buffer | undefined;
const uid = process.getuid?.() ?? 501;
const foreignUid = uid + 1;
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");

afterEach(() => {
  if (getuidDescriptor) {
    Object.defineProperty(process, "getuid", getuidDescriptor);
  } else {
    Reflect.deleteProperty(process, "getuid");
  }
});

function argumentsReply(argv: string[], argc = argv.length, environment = "SYNTHETIC_ENV=private") {
  const header = Buffer.alloc(4);
  header.writeInt32LE(argc);
  return Buffer.concat([
    header,
    Buffer.from(`/runtime path/node\0\0\0${argv.join("\0")}\0${environment}\0`),
  ]);
}

beforeEach(() => {
  Object.defineProperty(process, "getuid", { configurable: true, value: () => uid });
  reply = undefined;
  errno.mockReset().mockReturnValue(1);
  dead.mockReset().mockReturnValue(false);
  sysctl
    .mockReset()
    .mockImplementation((mib: Int32Array, _count: number, output: Buffer, size: Buffer) => {
      if (mib[1] === 8) {
        output.writeInt32LE(4096);
        size.writeBigUInt64LE(4n);
        return 0;
      }
      if (!reply) {
        return -1;
      }
      reply.copy(output);
      size.writeBigUInt64LE(BigInt(reply.length));
      return 0;
    });
});

it.each([
  { argv: ["node", "/app with spaces/openclaw.mjs", "", "doctor"], serviceMarker: undefined },
  { argv: ["openclaw-gateway", "", "", ""], serviceMarker: undefined },
  { argv: ["node", "dist/index.js"], serviceMarker: "openclaw" },
])("preserves native argv $argv and only the service marker", ({ argv, serviceMarker }) => {
  reply = argumentsReply(
    argv,
    argv.length,
    `UNRELATED_PRIVATE_VALUE=fixture${serviceMarker ? `\0OPENCLAW_SERVICE_MARKER=${serviceMarker}` : ""}`,
  );
  expect(readDarwinProcessCommand(12, uid)).toEqual({
    argv,
    ...(serviceMarker ? { serviceMarker } : {}),
  });
});

it.each([-1, 100])("rejects invalid native argument count %s", (argc) => {
  reply = argumentsReply(["node"], argc);
  expect(() => readDarwinProcessCommand(12, uid)).toThrow(/Darwin process arguments/);
});

it.each([
  { observedUid: uid, inspectorUid: uid, exited: false, error: 1, outcome: "uncertain" },
  { observedUid: undefined, inspectorUid: uid, exited: false, error: 13, outcome: "uncertain" },
  {
    observedUid: foreignUid,
    inspectorUid: undefined,
    exited: false,
    error: 1,
    outcome: "uncertain",
  },
  { observedUid: foreignUid, inspectorUid: uid, exited: false, error: 1, outcome: "foreign" },
  { observedUid: foreignUid, inspectorUid: uid, exited: false, error: 13, outcome: "foreign" },
  { observedUid: foreignUid, inspectorUid: uid, exited: true, error: 1, outcome: "gone" },
])(
  "classifies unreadable PID as $outcome ($observedUid/$inspectorUid, errno $error)",
  ({ observedUid, inspectorUid, exited, error, outcome }) => {
    Object.defineProperty(process, "getuid", {
      configurable: true,
      value: inspectorUid === undefined ? undefined : () => inspectorUid,
    });
    errno.mockReturnValue(error);
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
