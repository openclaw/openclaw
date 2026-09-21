import { beforeEach, expect, it, vi } from "vitest";

const { sysctl, pidPath, csops, errno, dead } = vi.hoisted(() => ({
  sysctl: vi.fn(),
  pidPath: vi.fn(),
  csops: vi.fn(),
  errno: vi.fn(),
  dead: vi.fn(),
}));
vi.mock("node:module", () => ({
  createRequire: () => () => ({
    load: () => ({
      func: (signature: string) =>
        signature.includes("sysctl(") ? sysctl : signature.includes("csops(") ? csops : pidPath,
    }),
    errno,
  }),
}));
vi.mock("../../shared/pid-alive.js", () => ({ isPidDefinitelyDead: dead }));
import { readDarwinProcessCommand } from "./darwin-process-command.js";

let reply: Buffer | undefined;
let executable: string | undefined;
const uid = process.getuid?.() ?? 501;
const foreignUid = uid + 1;

function argumentsReply(argv: string[], argc = argv.length) {
  const header = Buffer.alloc(4);
  header.writeInt32LE(argc);
  return Buffer.concat([
    header,
    Buffer.from(`/runtime path/node\0\0\0${argv.join("\0")}\0SYNTHETIC_ENV=private\0`),
  ]);
}

beforeEach(() => {
  reply = undefined;
  executable = undefined;
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
  pidPath.mockReset().mockImplementation((_pid: number, output: Buffer) => {
    if (!executable) {
      return 0;
    }
    return output.write(`${executable}\0`);
  });
  csops.mockReset().mockImplementation((_pid: number, _operation: number, output: Buffer) => {
    output.writeUInt32LE(0x0400_0001);
    return 0;
  });
});

it("preserves exact native argv boundaries without including environment bytes", () => {
  const argv = ["node", "/app with spaces/openclaw.mjs", "", "doctor"];
  reply = argumentsReply(argv);
  expect(readDarwinProcessCommand(12, uid)).toEqual({ argv });
});

it("preserves a rewritten process title with emptied original argument slots", () => {
  const argv = ["openclaw-gateway", "", "", ""];
  reply = argumentsReply(argv);
  expect(readDarwinProcessCommand(12, uid)).toEqual({ argv });
});

it.each(["invalid count", "truncated argument"])("rejects %s native argument bytes", (fault) => {
  reply = fault === "invalid count" ? argumentsReply(["node"], -1) : argumentsReply(["node"], 100);
  expect(() => readDarwinProcessCommand(12, uid)).toThrow(/Darwin process arguments/);
});

it.each([
  "/usr/libexec/native-service",
  "/System/Volumes/Update/MobileAsset/fixture.asset/Service.xpc/Contents/MacOS/Service",
])("records live kernel platform-signing evidence for foreign service %s", (file) => {
  executable = file;
  expect(readDarwinProcessCommand(12, foreignUid)).toEqual({
    executable,
    uid: foreignUid,
    argvUnavailable: true,
  });
});

it.each([
  "/usr/bin/python3",
  "/System/Library/Frameworks/Python.framework/Versions/2.7/bin/python",
  "/usr/libexec/node",
  "/usr/local/bin/bun",
  "/Applications/Fixture.app/Contents/MacOS/Fixture",
  "/System/Library/CoreServices/Fixture.app/Contents/MacOS/Fixture",
  "/tmp/openclaw-plugin-build-abc123/vendor/codex",
])("rejects unreadable argv for an ambiguous executable %s", (file) => {
  executable = file;
  expect(() => readDarwinProcessCommand(12, foreignUid)).toThrow("Cannot inspect Darwin arguments");
});

it.each([
  { kind: "non-platform executable", flags: 0x0000_0001, result: 0 },
  { kind: "invalid platform signature", flags: 0x0400_0000, result: 0 },
  { kind: "unavailable signing status", flags: 0x0400_0001, result: -1 },
])("rejects executable-only evidence from $kind", ({ flags, result }) => {
  executable = "/usr/libexec/fixture-native-service";
  csops.mockImplementation((_pid: number, _operation: number, output: Buffer) => {
    output.writeUInt32LE(flags);
    return result;
  });
  expect(() => readDarwinProcessCommand(12, foreignUid)).toThrow("Cannot inspect Darwin arguments");
});

it("does not extend foreign-service evidence to an unreadable current-user process", () => {
  executable = "/usr/libexec/native-service";
  expect(() => readDarwinProcessCommand(12, uid)).toThrow("Cannot inspect Darwin arguments");
});

it("distinguishes an exited process from an unavailable executable inspection", () => {
  expect(() => readDarwinProcessCommand(12, foreignUid)).toThrow("Cannot inspect Darwin arguments");
  dead.mockReturnValue(true);
  expect(readDarwinProcessCommand(12, foreignUid)).toBeUndefined();
});
