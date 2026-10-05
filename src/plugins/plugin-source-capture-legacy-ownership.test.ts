import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as usage from "../infra/temp-directory-usage.js";
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
    name: "owner changes during census",
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
    vi.spyOn(usage, "inspectTemporaryDirectoryUsage").mockReturnValue({ kind: "inactive" });
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
    await sweepPluginSourceCapturesForTest(stateDir);
    for (const root of roots) {
      expect(fs.existsSync(root), root).toBe(!removed);
      if (!removed) {
        expect(fs.readFileSync(path.join(root, "source.cjs"), "utf8")).toBe("producer-owned bytes");
      }
    }
  },
);
