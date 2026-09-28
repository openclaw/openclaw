import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as census from "../infra/openclaw-process-census.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { sweepPluginSourceCapturesForTest } from "./plugin-source-capture-directory.test-support.js";

const { ps, sysctl } = vi.hoisted(() => ({ ps: vi.fn(), sysctl: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: ps,
}));
vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  const createRequire = (file: string | URL) => {
    const require = actual.createRequire(file);
    return Object.assign(
      (id: string) =>
        id === "koffi"
          ? {
              load: () => ({
                func: (signature: string) => (signature.includes("sysctl(") ? sysctl : () => 0),
              }),
              errno: () => 22,
            }
          : require(id),
      require,
    );
  };
  return new Proxy(actual, {
    get(target, key, receiver) {
      return key === "createRequire" ? createRequire : Reflect.get(target, key, receiver);
    },
  });
});

const temp = useAutoCleanupTempDirTracker(afterEach);
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
let temporary: string;
let stateDir: string;

beforeEach(() => {
  const parent = temp.make("legacy-capture-ownership-");
  temporary = path.join(parent, "shared-tmp");
  stateDir = path.join(parent, "state");
  fs.mkdirSync(temporary);
  fs.mkdirSync(path.join(stateDir, "tmp"), { recursive: true });
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, temporary);
  }
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  ps.mockReset();
  sysctl.mockReset();
  if (getuidDescriptor) {
    Object.defineProperty(process, "getuid", getuidDescriptor);
  } else {
    Reflect.deleteProperty(process, "getuid");
  }
});

it.each([
  {
    name: "foreign capture under root",
    uid: 0,
    peerUid: 501,
    captureUid: 501,
    changed: false,
    removed: false,
  },
  {
    name: "owner changes during census",
    uid: 0,
    peerUid: 501,
    captureUid: 0,
    changed: true,
    removed: false,
  },
  {
    name: "unrelated root daemon",
    uid: 501,
    peerUid: 0,
    captureUid: 501,
    changed: false,
    removed: true,
  },
  {
    name: "root-owned scratch",
    uid: 0,
    peerUid: 501,
    captureUid: 0,
    changed: false,
    removed: true,
  },
])(
  "automatic sweep respects legacy custody: $name",
  async ({ uid, peerUid, captureUid, changed, removed }) => {
    const inspectProcesses = vi.spyOn(census, "inspectOtherOpenClawProcesses");
    mockProcessPlatform("darwin");
    Object.defineProperty(process, "getuid", { configurable: true, value: () => uid });
    const roots = [
      path.join(temporary, "openclaw-plugin-build-retained"),
      path.join(stateDir, "tmp", "openclaw-model-catalog-retained"),
    ];
    for (const root of roots) {
      fs.mkdirSync(root, { mode: 0o700 });
      fs.writeFileSync(path.join(root, "source.cjs"), "producer-owned bytes");
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1_000);
    const lstat = fsPromises.lstat.bind(fsPromises);
    const inspected = new Set<string>();
    vi.spyOn(fsPromises, "lstat").mockImplementation(async (target, options) => {
      const stat = await lstat(target, options);
      if (typeof target === "string" && roots.includes(target)) {
        Object.assign(stat, { uid: changed && inspected.has(target) ? peerUid : captureUid });
        inspected.add(target);
      }
      return stat;
    });
    const peer = 2_000_000_000;
    ps.mockReturnValue({
      status: 0,
      stdout: `${process.pid} ${process.pid} S 0 ${uid}\n${peer} ${peer} S 0 ${peerUid}\n`,
    });
    sysctl.mockImplementation((mib: Int32Array, _count: number, output: Buffer, size: Buffer) => {
      if (mib[1] === 8) {
        output.writeInt32LE(4096);
        size.writeBigUInt64LE(4n);
        return 0;
      }
      if (mib[2] === peer) {
        return -1;
      }
      output.writeInt32LE(1);
      const length = output.write("/node\0openclaw-gateway\0", 4) + 4;
      size.writeBigUInt64LE(BigInt(length));
      return 0;
    });
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) =>
      pid === peer && signal === 0 ? true : kill(pid, signal),
    );
    await sweepPluginSourceCapturesForTest(stateDir);
    expect(inspectProcesses).toHaveReturnedWith({ pids: [] });
    for (const root of roots) {
      expect(fs.existsSync(root), root).toBe(!removed);
      if (!removed) {
        expect(fs.readFileSync(path.join(root, "source.cjs"), "utf8")).toBe("producer-owned bytes");
      }
    }
  },
);
