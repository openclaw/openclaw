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

it.each([uid, undefined])(
  "preserves exact native argv boundaries with observed uid %s",
  (observedUid) => {
    const argv = ["node", "/app with spaces/openclaw.mjs", "", "doctor"];
    reply = argumentsReply(argv);
    expect(readDarwinProcessCommand(12, observedUid)).toEqual({ argv });
  },
);

it("preserves a rewritten process title with emptied original argument slots", () => {
  const argv = ["openclaw-gateway", "", "", ""];
  reply = argumentsReply(argv);
  expect(readDarwinProcessCommand(12, uid)).toEqual({ argv });
});

it("retains only the OpenClaw service marker from the native environment", () => {
  const argv = ["node", "dist/index.js"];
  reply = argumentsReply(
    argv,
    argv.length,
    "UNRELATED_PRIVATE_VALUE=fixture\0OPENCLAW_SERVICE_MARKER=openclaw",
  );
  expect(readDarwinProcessCommand(12, uid)).toEqual({ argv, serviceMarker: "openclaw" });
});

it.each(["invalid count", "truncated argument"])("rejects %s native argument bytes", (fault) => {
  reply = fault === "invalid count" ? argumentsReply(["node"], -1) : argumentsReply(["node"], 100);
  expect(() => readDarwinProcessCommand(12, uid)).toThrow(/Darwin process arguments/);
});

it.each([1, 13, 22])("excludes unreadable foreign-UID argv with errno %s", (error) => {
  errno.mockReturnValue(error);
  expect(readDarwinProcessCommand(12, foreignUid)).toEqual({
    uid: foreignUid,
    argvUnavailable: true,
  });
});

it.each(
  [1, 13, 22].flatMap((error) => [uid, undefined].map((observedUid) => ({ error, observedUid }))),
)(
  "holds unreadable argv with current or unavailable UID $observedUid and errno $error",
  ({ error, observedUid }) => {
    errno.mockReturnValue(error);
    expect(() => readDarwinProcessCommand(12, observedUid)).toThrow(
      "Could not classify PID 12: cannot inspect Darwin arguments",
    );
  },
);

it("distinguishes an exited process from unreadable arguments", () => {
  expect(() => readDarwinProcessCommand(12, uid)).toThrow(
    "Could not classify PID 12: cannot inspect Darwin arguments",
  );
  dead.mockReturnValue(true);
  expect(readDarwinProcessCommand(12, foreignUid)).toBeUndefined();
});

it("holds unreadable argv when the inspecting UID is unavailable", () => {
  Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
  expect(() => readDarwinProcessCommand(12, foreignUid)).toThrow(
    "Could not classify PID 12: cannot inspect Darwin arguments",
  );
});
