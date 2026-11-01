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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1_000);
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
  // name, current uid, peer uid, capture uid, owner changes, removed
  ["foreign capture under root", 0, 501, 501, false, false],
  ["owner changes before removal", 0, 501, 0, true, false],
  ["current user scratch", 501, 0, 501, false, true],
  ["root-owned scratch", 0, 501, 0, false, true],
] as const)(
  "automatic sweep respects legacy custody: %s",
  async (_name, uid, peerUid, captureUid, changed, removed) => {
    Object.defineProperty(process, "getuid", { configurable: true, value: () => uid });
    const roots = [
      path.join(temporary, "openclaw-plugin-build-retained"),
      path.join(stateDir, "tmp", "openclaw-model-catalog-retained"),
    ];
    for (const root of roots) {
      fs.mkdirSync(root, { mode: 0o700 });
      fs.writeFileSync(path.join(root, "source.cjs"), "producer-owned bytes");
    }
    const lstat = fsPromises.lstat.bind(fsPromises);
    const lstatSync = fs.lstatSync.bind(fs);
    const inspected = new Set<number | bigint>();
    const applyFixtureUid = <T extends fs.Stats | fs.BigIntStats>(target: unknown, stat: T): T => {
      if ((typeof target === "string" && roots.includes(target)) || inspected.has(stat.ino)) {
        Object.assign(stat, { uid: changed && inspected.has(stat.ino) ? peerUid : captureUid });
        inspected.add(stat.ino);
      }
      return stat;
    };
    vi.spyOn(fsPromises, "lstat").mockImplementation(async (target, options) =>
      applyFixtureUid(target, await lstat(target, options)),
    );
    vi.spyOn(fs, "lstatSync").mockImplementation((target, options) => {
      const stat = lstatSync(target, options);
      return stat && applyFixtureUid(target, stat);
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
    let candidateInspected = false;
    const lstat = fsPromises.lstat.bind(fsPromises);
    vi.spyOn(fsPromises, "lstat").mockImplementation(async (target, options) => {
      const stat = await lstat(target, options);
      candidateInspected ||= target === root;
      return stat;
    });
    const refusal = new Error("fixture maintenance authority revoked");
    let authorityChecked = false;
    const assertCurrent = async () => {
      if (!candidateInspected || authorityChecked) {
        return;
      }
      authorityChecked = true;
      await Promise.resolve();
      if (change === "revocation") {
        throw refusal;
      }
      fs.renameSync(root, parked);
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, "payload"), "replacement bytes");
    };
    const result = await prunePluginNativeCaptureDirectories(stateDir, new Set(), assertCurrent);
    const preserved = change === "replacement" ? parked : root;
    expect(fs.readFileSync(path.join(preserved, "payload"), "utf8")).toBe("owned bytes");
    expect(result.warnings).toEqual(change === "revocation" ? [refusal.message] : []);
    if (change === "replacement") {
      expect(fs.readFileSync(path.join(root, "payload"), "utf8")).toBe("replacement bytes");
    }
  },
);
