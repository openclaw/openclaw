import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prunePluginNativeCaptureDirectories } from "./plugin-source-capture-directory.js";
import { sweepPluginSourceCapturesForTest } from "./plugin-source-capture-directory.test-support.js";

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
    name: "owner changes before removal",
    uid: 0,
    peerUid: 501,
    captureUid: 0,
    changed: true,
    removed: false,
  },
  {
    name: "current user scratch",
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
    const lstatSync = fs.lstatSync.bind(fs);
    const inspected = new Set<number | bigint>();
    const applyFixtureUid = (target: unknown, stat: fs.Stats | fs.BigIntStats) => {
      if ((typeof target === "string" && roots.includes(target)) || inspected.has(stat.ino)) {
        Object.assign(stat, { uid: changed && inspected.has(stat.ino) ? peerUid : captureUid });
        inspected.add(stat.ino);
      }
    };
    vi.spyOn(fsPromises, "lstat").mockImplementation(async (target, options) => {
      const stat = await lstat(target, options);
      applyFixtureUid(target, stat);
      return stat;
    });
    vi.spyOn(fs, "lstatSync").mockImplementation((target, options) => {
      const stat = lstatSync(target, options);
      if (stat) {
        applyFixtureUid(target, stat);
      }
      return stat;
    });
    await sweepPluginSourceCapturesForTest(stateDir);
    for (const root of roots) {
      expect(fs.existsSync(root), root).toBe(!removed);
      if (!removed) {
        expect(fs.readFileSync(path.join(root, "source.cjs"), "utf8")).toBe("producer-owned bytes");
      }
    }
  },
);

it.each(["revocation", "replacement"] as const)(
  "preserves tokenless payloads across cleanup authority %s",
  async (change) => {
    const root = path.join(stateDir, "tmp", "plugin-captures", "tokenless");
    const parked = path.join(stateDir, "original-payload");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "payload"), "owned bytes");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1_000);
    let candidateInspected = false;
    const lstat = fsPromises.lstat.bind(fsPromises);
    vi.spyOn(fsPromises, "lstat").mockImplementation(async (target, options) => {
      const stat = await lstat(target, options);
      if (target === root) {
        candidateInspected = true;
      }
      return stat;
    });
    const refusal = new Error("fixture maintenance authority revoked");
    let guardedPath: string | undefined;
    const assertCurrent = async () => {
      const target = root;
      if (!candidateInspected || !target || guardedPath) {
        return;
      }
      guardedPath = target;
      await Promise.resolve();
      if (change === "revocation") {
        throw refusal;
      }
      fs.renameSync(target, parked);
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "payload"), "replacement bytes");
    };
    const result = await prunePluginNativeCaptureDirectories(stateDir, new Set(), assertCurrent);
    const preserved = change === "replacement" ? parked : root;
    expect(fs.readFileSync(path.join(preserved, "payload"), "utf8")).toBe("owned bytes");
    if (change === "revocation") {
      expect(result.warnings).toEqual([refusal.message]);
    } else {
      expect(fs.readFileSync(path.join(guardedPath!, "payload"), "utf8")).toBe("replacement bytes");
      expect(result.warnings).toEqual([]);
    }
  },
);
