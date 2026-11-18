import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  createMirrorStaging,
  createStaging,
  runStagingCommand,
} from "../../scripts/crabbox-staging.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const injected = vi.hoisted(() => ({
  dev: 0n,
  path: "",
  ino: 0n,
  birthtime: 0n,
  volume: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" as string | undefined,
  beforeRemove: undefined as ((path: string) => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: (...args: unknown[]) => {
      injected.beforeRemove?.(String(args[0]));
      return Reflect.apply(actual.rmSync, actual, args);
    },
    lstatSync: (...args: unknown[]) => {
      const stat = Reflect.apply(actual.lstatSync, actual, args);
      if (stat && typeof stat.dev === "bigint") {
        stat.dev += injected.dev;
        if (String(args[0]) === injected.path) {
          stat.ino += injected.ino;
          stat.birthtimeNs += injected.birthtime;
        }
      }
      return stat;
    },
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => {
      const stdout =
        args[0] === "/usr/bin/stat"
          ? "disk3s5\n"
          : args[0] === "/usr/sbin/diskutil"
            ? injected.volume
              ? `<key>VolumeUUID</key><string>${injected.volume}</string>`
              : ""
            : args[0] === "/usr/sbin/ioreg"
              ? '"IOPlatformUUID" = "aaaaaaaa-bbbb-4ccc-8ddd-dddddddddddd"'
              : args[0] === "/usr/sbin/sysctl"
                ? "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff\n"
                : undefined;
      return stdout === undefined
        ? Reflect.apply(actual.spawnSync, actual, args)
        : { status: 0, stdout };
    },
  };
});
vi.mock("../../scripts/crabbox-staging-users.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/crabbox-staging-users.mts")>()),
  verifyNoStagingUsers: async () => ({ ok: true }),
}));

const temporary = useAutoCleanupTempDirTracker(afterAll);
const posixIt = it.skipIf(process.platform === "win32");
let repository: string;
let root: string;
beforeAll(() => {
  root = temporary.make("openclaw-staging-identity-");
  repository = join(root, "repository");
  mkdirSync(repository);
  const initialized = spawnSync("git", ["init", "--quiet", "--template=", repository], {
    env: createNestedGitEnv(),
  });
  expect(initialized.status).toBe(0);
});
beforeEach(() => {
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
  // Model macOS metadata on every CI host; only filesystem/device observations
  // are injected. The real staging owner creates, inspects, and disposes fixtures.
  const nativeProcess = process;
  vi.stubGlobal(
    "process",
    new Proxy(nativeProcess, {
      get(target, key) {
        return key === "platform" ? "darwin" : Reflect.get(target, key);
      },
    }),
  );
});
afterEach(() => {
  injected.dev = injected.ino = injected.birthtime = 0n;
  injected.path = "";
  injected.volume = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  injected.beforeRemove = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stage(legacy = false) {
  const syncRoot = temporary.make("openclaw-staging-identity-copy-");
  const owner = createMirrorStaging(syncRoot, repository)!;
  expect(owner).toBeDefined();
  mkdirSync(join(owner.staging.payload, "source"));
  writeFileSync(join(owner.staging.root, "mirror.sqlite"), "closed fixture cache");
  owner.staging.prepared({ files: [], deleted: [] });
  owner.finish();
  const receiptPath = join(owner.staging.root, "staging.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (legacy) {
    delete receipt.identityRecordedAtNs;
    for (const identity of [
      receipt.rootIdentity,
      receipt.payloadIdentity,
      receipt.repositoryIdentity,
      receipt.mirror.slotIdentity,
      receipt.claims?.anchor,
    ].filter(Boolean)) {
      delete identity.stable;
    }
    writeFileSync(receiptPath, JSON.stringify(receipt));
  }
  return { syncRoot, owner, receipt, receiptPath };
}

async function command(syncRoot: string, args: string[]) {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const result = await runStagingCommand(args, syncRoot, {
    binary: "unused-crabbox",
    cwd: repository,
  });
  const report = JSON.parse(output.mock.calls.at(-1)![0]);
  output.mockRestore();
  return { result, report };
}

posixIt("persists a newly available UUID during ordinary capsule preparation", async () => {
  const syncRoot = temporary.make("openclaw-staging-identity-capsule-");
  injected.volume = undefined;
  const owner = createStaging(syncRoot, repository);
  mkdirSync(join(owner.payload, "source"));
  const receiptPath = join(owner.root, "staging.json");
  const initial = JSON.parse(readFileSync(receiptPath, "utf8"));
  expect(initial.rootIdentity.stable.volume).toBe("device:" + initial.rootIdentity.dev);
  await Promise.resolve();
  injected.volume = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  owner.prepared({ files: [], deleted: [] });
  const prepared = JSON.parse(readFileSync(receiptPath, "utf8"));
  for (const identity of [prepared.rootIdentity, prepared.payloadIdentity]) {
    expect(identity.stable.volume).toBe("uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  }
  injected.dev = 2n;
  owner.dispose();
  expect(existsSync(owner.root)).toBe(false);
});

posixIt.each([false, true])(
  "inspects and recovers an idle mirror after a dev-only change (legacy=%s)",
  async (legacy) => {
    const f = stage(legacy);
    const original = readFileSync(f.receiptPath, "utf8");
    injected.dev = 2n;
    const inspection = await command(f.syncRoot, ["inspect"]);
    expect(inspection.report.entries).toEqual([
      expect.objectContaining({
        id: f.receipt.id,
        reason: expect.stringContaining("Idle source mirror retained"),
      }),
    ]);
    expect(readFileSync(f.receiptPath, "utf8")).toBe(original);
    let checkedDisposal = false;
    injected.beforeRemove = (path) => {
      if (path === f.owner.staging.payload) {
        const saved = JSON.parse(readFileSync(f.receiptPath, "utf8"));
        for (const identity of [
          saved.rootIdentity,
          saved.payloadIdentity,
          saved.mirror.slotIdentity,
        ]) {
          expect(identity.stable).toMatchObject({
            volume: "uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            birthtimeNs: expect.any(String),
            path: expect.any(String),
          });
        }
        checkedDisposal = true;
      }
    };
    const recovery = await command(f.syncRoot, ["recover", f.receipt.id]);
    expect(recovery.report, recovery.report.reason).toMatchObject({ recovered: true });
    expect(checkedDisposal).toBe(true);
    expect(existsSync(f.owner.staging.root)).toBe(false);
    expect(readdirSync(join(f.syncRoot, "mirrors"))).toEqual([".allocation.lock"]);
  },
);

posixIt.each([
  "inode",
  "birthtime",
  "volume",
  "unavailable-volume",
  "invalid-device",
  "path",
  "incomplete",
  "foreign",
  "legacy-replacement",
  "legacy-replacement-same-device",
])("refuses %s changes to staging ownership", async (change) => {
  const f = stage(change.startsWith("legacy-replacement") || change === "invalid-device");
  injected.dev = 2n;
  injected.path = f.owner.staging.root;
  if (change === "inode") {
    injected.ino = 1n;
  }
  if (change === "birthtime") {
    injected.birthtime = 1n;
  }
  if (change.startsWith("legacy-replacement")) {
    injected.birthtime = 86_400_000_000_000n;
    if (change === "legacy-replacement-same-device") {
      injected.dev = 0n;
    }
  }
  if (change === "volume" || change === "unavailable-volume") {
    await Promise.resolve();
    injected.dev = 0n;
    injected.volume = change === "volume" ? "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee" : undefined;
  }
  if (["path", "incomplete", "invalid-device"].includes(change)) {
    if (change === "invalid-device") {
      f.receipt.rootIdentity.dev = "unknown";
    }
    if (change === "path") {
      f.receipt.rootIdentity.stable.path = join(root, "foreign");
    }
    if (change === "incomplete") {
      delete f.receipt.rootIdentity.stable.birthtimeNs;
    }
    writeFileSync(f.receiptPath, JSON.stringify(f.receipt));
  }
  if (change === "foreign") {
    mkdirSync(join(f.owner.staging.root, "foreign"));
  }
  const recovery = await command(f.syncRoot, ["recover", f.receipt.id]);
  expect(recovery.report).toMatchObject({ recovered: false });
  expect(recovery.report.reason).toMatch(
    change === "foreign"
      ? /unknown or replaced metadata sibling/
      : /identity changed|invalid metadata/,
  );
  expect(existsSync(f.owner.staging.payload)).toBe(true);
});

posixIt.each(["recorded", "receipt-only", "empty-slot"])(
  "resumes legacy %s disposal across a device change",
  async (interruption) => {
    const f = stage();
    injected.beforeRemove = (path) => {
      if (path === f.owner.staging.payload) {
        throw new Error("fixture interrupted disposal");
      }
    };
    expect((await command(f.syncRoot, ["recover", f.receipt.id])).report).toMatchObject({
      recovered: false,
      reason: "fixture interrupted disposal",
    });
    injected.beforeRemove = undefined;
    const disposalPath = join(f.syncRoot, "openclaw-crabbox-sync-disposal-" + f.receipt.id);
    const disposal = JSON.parse(readFileSync(disposalPath, "utf8"));
    const legacyReceipt = disposal.receipt;
    delete legacyReceipt.identityRecordedAtNs;
    for (const identity of [
      legacyReceipt.rootIdentity,
      legacyReceipt.payloadIdentity,
      legacyReceipt.repositoryIdentity,
      legacyReceipt.mirror.slotIdentity,
      legacyReceipt.claims?.anchor,
      disposal.slotIdentity,
    ].filter(Boolean)) {
      delete identity.stable;
    }
    writeFileSync(f.receiptPath, JSON.stringify(legacyReceipt));
    if (interruption === "empty-slot") {
      // Historical empty-slot disposal has no receipt and an already absent root.
      delete disposal.receipt;
      rmSync(f.owner.staging.root, { recursive: true });
    }
    writeFileSync(disposalPath, JSON.stringify(disposal));
    if (interruption === "receipt-only") {
      rmSync(disposalPath);
    }
    injected.dev = 2n;
    const resumed = await command(f.syncRoot, ["recover", f.receipt.id]);
    expect(resumed.report, resumed.report.reason).toMatchObject({ recovered: true });
    expect(existsSync(f.owner.staging.root)).toBe(false);
    expect(existsSync(disposalPath)).toBe(false);
  },
);

posixIt.each([false, true])(
  "keeps a volume lookup fallback strict to its device (renumbered=%s)",
  async (renumbered) => {
    injected.volume = undefined;
    const f = stage();
    expect(f.receipt.rootIdentity.stable.volume).toBe("device:" + f.receipt.rootIdentity.dev);
    await Promise.resolve();
    injected.volume = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    injected.dev = renumbered ? 2n : 0n;
    const recovered = await command(f.syncRoot, ["recover", f.receipt.id]);
    expect(recovered.report, recovered.report.reason).toMatchObject({ recovered: !renumbered });
    expect(existsSync(f.owner.staging.root)).toBe(renumbered);
  },
);

posixIt("keeps an idle mirror with an existing recovery lock protected", async () => {
  const f = stage();
  const before = readFileSync(f.receiptPath, "utf8");
  mkdirSync(join(f.owner.staging.root, "recovery.lock"));
  const result = await command(f.syncRoot, ["recover", f.receipt.id]);
  expect(result.report).toMatchObject({
    recovered: false,
    reason: expect.stringContaining("recovery lock"),
  });
  expect(existsSync(f.owner.staging.payload)).toBe(true);
  expect(readFileSync(f.receiptPath, "utf8")).toBe(before);
});
