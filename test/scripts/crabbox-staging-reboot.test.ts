import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  processDomain,
  type ProcessProvenance,
} from "../../scripts/crabbox-staging-provenance.mts";
import { createStaging, runStagingCommand } from "../../scripts/crabbox-staging.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const injected = vi.hoisted(() => ({
  provenance: undefined as ProcessProvenance | undefined,
  bootTimeNs: undefined as bigint | undefined,
  volume: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" as string | undefined,
  changedInodePath: "",
  recoveryLocksCreated: 0,
  userFailure: "",
  claimFailure: "",
  witnessFailure: "",
  onUsers: undefined as (() => void | Promise<void>) | undefined,
  onRevalidate: undefined as (() => void) | undefined,
  beforeRemove: undefined as ((path: string) => void) | undefined,
}));
vi.mock("../../scripts/crabbox-staging-provenance.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/crabbox-staging-provenance.mts")>()),
  currentProcessProvenance: () => injected.provenance,
  currentBootTimeNs: () => injected.bootTimeNs,
}));
vi.mock("../../scripts/crabbox-staging-users.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/crabbox-staging-users.mts")>()),
  verifyNoStagingUsers: async () => {
    await injected.onUsers?.();
    return injected.userFailure ? { ok: false, reason: injected.userFailure } : { ok: true };
  },
}));
vi.mock("../../scripts/crabbox-staging-claims.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/crabbox-staging-claims.mts")>()),
  verifyNoStagingClaims: async () =>
    injected.claimFailure
      ? { ok: false, reason: injected.claimFailure, error: new Error(injected.claimFailure) }
      : { ok: true },
}));
vi.mock("../../scripts/crabbox-staging-witness.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/crabbox-staging-witness.mts")>()),
  verifySourceWitness: async () =>
    injected.witnessFailure
      ? { ok: false, reason: injected.witnessFailure, error: new Error(injected.witnessFailure) }
      : { ok: true, revalidate: () => injected.onRevalidate?.() },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (...args: unknown[]) => {
      const stat = Reflect.apply(actual.lstatSync, actual, args);
      if (stat && typeof stat.ino === "bigint" && String(args[0]) === injected.changedInodePath) {
        stat.ino += 1n;
      }
      return stat;
    },
    mkdirSync: (...args: unknown[]) => {
      if (String(args[0]).endsWith("/recovery.lock")) {
        injected.recoveryLocksCreated += 1;
      }
      return Reflect.apply(actual.mkdirSync, actual, args);
    },
    rmSync: (...args: unknown[]) => {
      injected.beforeRemove?.(String(args[0]));
      return Reflect.apply(actual.rmSync, actual, args);
    },
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => {
      if (args[0] === "/usr/bin/stat") {
        return { status: 0, stdout: "disk3s5\n" };
      }
      if (args[0] === "/usr/sbin/diskutil") {
        return {
          status: 0,
          stdout: injected.volume ? `<key>VolumeUUID</key><string>${injected.volume}</string>` : "",
        };
      }
      return Reflect.apply(actual.spawnSync, actual, args);
    },
  };
});

const oldHost: ProcessProvenance = Object.freeze({
  platform: "darwin",
  hostId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  bootId: "aaaaaaaa-bbbb-4ccc-8ddd-111111111111",
  pidNamespace: "",
});
const newHost: ProcessProvenance = Object.freeze({
  ...oldHost,
  bootId: "aaaaaaaa-bbbb-4ccc-8ddd-222222222222",
});
const posixIt = it.skipIf(process.platform === "win32");
const temporary = useAutoCleanupTempDirTracker(afterAll);
let repository: string;
let suiteRoot: string;
beforeAll(() => {
  suiteRoot = temporary.make("openclaw-staging-reboot-");
  repository = join(suiteRoot, "repository");
  mkdirSync(repository);
  const initialized = spawnSync("git", ["init", "--quiet", "--template=", repository], {
    env: createNestedGitEnv(),
  });
  expect(initialized.status).toBe(0);
});
beforeEach(() => {
  const original = process;
  vi.stubGlobal(
    "process",
    new Proxy(original, {
      get(target, key) {
        return key === "platform" ? "darwin" : Reflect.get(target, key);
      },
    }),
  );
  vi.stubEnv("XDG_STATE_HOME", join(suiteRoot, "state"));
  injected.provenance = oldHost;
  injected.bootTimeNs = BigInt(Date.now() + 86_400_000) * 1_000_000n;
  injected.volume = oldHost.hostId;
  injected.changedInodePath = "";
  injected.recoveryLocksCreated = 0;
  injected.userFailure = injected.claimFailure = injected.witnessFailure = "";
  injected.onUsers = undefined;
  injected.onRevalidate = undefined;
  injected.beforeRemove = undefined;
});
afterEach(() => {
  injected.beforeRemove = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stage(legacy = false) {
  const syncRoot = temporary.make("openclaw-staging-reboot-copy-");
  const owner = createStaging(syncRoot, repository);
  expect(owner.recorded).toBe(true);
  mkdirSync(join(owner.payload, "source"));
  owner.prepared(
    { files: [], deleted: [] },
    {
      gitDir: join(repository, ".git"),
      ref: "refs/openclaw/source-fixture",
      commit: "1".repeat(40),
    },
  );
  const receiptPath = join(owner.root, "staging.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (legacy) {
    delete receipt.ownerProvenance;
    delete receipt.syncRootIdentity;
    receipt.ownerDomain = processDomain(oldHost);
    writeFileSync(receiptPath, JSON.stringify(receipt) + "\n");
  }
  return { syncRoot, owner, receiptPath, id: String(receipt.id) };
}
type Fixture = ReturnType<typeof stage>;
function receiptDigest(fixture: Fixture) {
  return createHash("sha256").update(readFileSync(fixture.receiptPath)).digest("hex");
}
function rewriteReceipt(fixture: Fixture, change: (receipt: Record<string, unknown>) => void) {
  const receipt = JSON.parse(readFileSync(fixture.receiptPath, "utf8"));
  change(receipt);
  writeFileSync(fixture.receiptPath, JSON.stringify(receipt) + "\n");
}
function confirmationArgs(fixture: Fixture) {
  return [
    "recover",
    fixture.id,
    "--confirm-same-host-prior-boot",
    "--receipt-sha256",
    receiptDigest(fixture),
  ];
}
async function command(fixture: Fixture, args: string[]) {
  // Volume lookups coalesce within one synchronous turn; recovery starts a new one.
  await Promise.resolve();
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const code = await runStagingCommand(args, fixture.syncRoot, {
      binary: "unused-crabbox",
      cwd: repository,
    });
    return { code, report: JSON.parse(output.mock.calls.at(-1)![0]) };
  } finally {
    output.mockRestore();
  }
}

posixIt(
  "records explicit provenance and recovers after a same-host reboot without probing the reused PID",
  async () => {
    const fixture = stage();
    const stored = JSON.parse(readFileSync(fixture.receiptPath, "utf8"));
    expect(stored).toMatchObject({
      ownerPid: process.pid,
      ownerProvenance: oldHost,
      syncRootIdentity: { stable: { volume: "uuid:" + oldHost.hostId } },
    });
    injected.provenance = newHost;
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const outcome = await command(fixture, ["recover", fixture.id]);
    expect(outcome.report, outcome.report.reason).toMatchObject({ recovered: true });
    expect(kill.mock.calls.filter(([, signal]) => signal === 0)).toEqual([]);
    expect(existsSync(fixture.owner.root)).toBe(false);
  },
);

posixIt.each(["different host", "different namespace", "missing provenance"])(
  "refuses %s as proof of producer death",
  async (defect) => {
    if (defect === "different namespace") {
      injected.provenance = Object.freeze({
        platform: "linux",
        hostId: "1".repeat(32),
        bootId: oldHost.bootId,
        pidNamespace: "pid:[4026531836]",
      });
    }
    const fixture = stage();
    if (defect === "different host") {
      injected.provenance = Object.freeze({
        ...newHost,
        hostId: "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      });
    } else if (defect === "different namespace") {
      injected.provenance = Object.freeze({
        platform: "linux",
        hostId: "1".repeat(32),
        bootId: newHost.bootId,
        pidNamespace: "pid:[4026531837]",
      });
    } else {
      rewriteReceipt(fixture, (receipt) => {
        delete receipt.ownerProvenance;
        delete receipt.ownerDomain;
      });
      injected.provenance = newHost;
    }
    const before = readFileSync(fixture.receiptPath, "utf8");
    const outcome = await command(fixture, ["recover", fixture.id]);
    expect(outcome.report).toMatchObject({
      recovered: false,
      reason: expect.stringMatching(/host|namespace/),
    });
    expect(readFileSync(fixture.receiptPath, "utf8")).toBe(before);
    expect(injected.recoveryLocksCreated).toBe(0);
  },
);

posixIt(
  "previews legacy eligibility without writes, then persists exact receipt-bound confirmation before removal",
  async () => {
    const fixture = stage(true);
    injected.provenance = newHost;
    const before = readFileSync(fixture.receiptPath, "utf8");
    const beforeStat = lstatSync(fixture.receiptPath, { bigint: true });
    const beforeFiles = readdirSync(fixture.owner.root).toSorted();
    injected.onUsers = () => {
      expect(existsSync(join(fixture.owner.root, "recovery.lock"))).toBe(false);
    };
    const preview = await command(fixture, ["inspect", fixture.id, "--same-host-prior-boot"]);
    expect(preview.report, preview.report.reason).toMatchObject({
      eligible: true,
      inspectionOnly: true,
      confirmationRequired: true,
      receiptSha256: receiptDigest(fixture),
    });
    expect(readFileSync(fixture.receiptPath, "utf8")).toBe(before);
    expect(lstatSync(fixture.receiptPath, { bigint: true }).mtimeNs).toBe(beforeStat.mtimeNs);
    expect(readdirSync(fixture.owner.root).toSorted()).toEqual(beforeFiles);
    expect(injected.recoveryLocksCreated).toBe(0);
    injected.onUsers = undefined;
    let observedConfirmation: unknown;
    injected.beforeRemove = (path) => {
      if (path === fixture.owner.payload) {
        observedConfirmation = JSON.parse(
          readFileSync(fixture.receiptPath, "utf8"),
        ).operatorConfirmation;
      }
    };
    const recovered = await command(fixture, [
      "recover",
      fixture.id,
      "--confirm-same-host-prior-boot",
      "--receipt-sha256",
      preview.report.receiptSha256,
    ]);
    expect(recovered.report, recovered.report.reason).toMatchObject({
      recovered: true,
      operatorConfirmation: {
        kind: "same-host-prior-boot",
        receiptSha256: preview.report.receiptSha256,
        receiptMtimeNs: String(beforeStat.mtimeNs),
        current: newHost,
      },
    });
    expect(observedConfirmation).toEqual(recovered.report.operatorConfirmation);
    expect(existsSync(fixture.owner.root)).toBe(false);
  },
);

const legacyRefusals = [
  { defect: "stale digest", reason: /digest changed/ },
  { defect: "missing confirmation flag", reason: /requires --confirm/ },
  { defect: "missing digest flag", reason: /requires --confirm/ },
  { defect: "same-boot digest", reason: /different boot/ },
  { defect: "receipt at boot time", reason: /mtime must predate/ },
  { defect: "receipt after boot time", reason: /mtime must predate/ },
  { defect: "unavailable current provenance", reason: /verified current host\/boot/ },
  { defect: "unavailable current boot time", reason: /verified current host\/boot/ },
  { defect: "missing required metadata", reason: /invalid metadata/ },
  { defect: "missing manifest", reason: /ENOENT/ },
  { defect: "manifest mismatch", reason: /manifest does not match/ },
  { defect: "changed inode", reason: /identity changed/ },
  { defect: "changed volume", reason: /identity changed/ },
  { defect: "unavailable volume UUID", reason: /identity changed|UUID-backed/ },
  { defect: "existing recovery lock", reason: /Another or interrupted recovery/ },
  { defect: "live users", reason: /fixture live staging user/ },
  { defect: "unavailable lsof", reason: /fixture unavailable user census/ },
  { defect: "native claims", reason: /fixture native claims/, writesConfirmation: true },
  { defect: "source witness", reason: /fixture retained source/, writesConfirmation: true },
];
posixIt.each(legacyRefusals)(
  "refuses legacy disposition with $defect",
  async ({ defect, reason, writesConfirmation }) => {
    const fixture = stage(true);
    injected.provenance = newHost;
    if (defect === "same-boot digest") {
      rewriteReceipt(fixture, (receipt) => {
        receipt.ownerDomain = processDomain(newHost);
      });
    }
    if (defect === "receipt at boot time" || defect === "receipt after boot time") {
      injected.bootTimeNs =
        lstatSync(fixture.receiptPath, { bigint: true }).mtimeNs -
        (defect === "receipt after boot time" ? 1n : 0n);
    }
    if (defect === "unavailable current provenance") {
      injected.provenance = undefined;
    }
    if (defect === "unavailable current boot time") {
      injected.bootTimeNs = undefined;
    }
    if (defect === "missing required metadata") {
      rewriteReceipt(fixture, (receipt) => {
        delete receipt.rootIdentity;
      });
    }
    if (defect === "missing manifest") {
      rmSync(join(fixture.owner.root, "manifest.json"));
    }
    if (defect === "manifest mismatch") {
      writeFileSync(join(fixture.owner.root, "manifest.json"), "{}\n");
    }
    if (defect === "changed inode") {
      injected.changedInodePath = fixture.owner.root;
    }
    if (defect === "changed volume") {
      injected.volume = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    }
    if (defect === "unavailable volume UUID") {
      injected.volume = undefined;
    }
    if (defect === "existing recovery lock") {
      mkdirSync(join(fixture.owner.root, "recovery.lock"));
    }
    if (defect === "live users") {
      injected.userFailure = "fixture live staging user";
    }
    if (defect === "unavailable lsof") {
      injected.userFailure = "fixture unavailable user census";
    }
    if (defect === "native claims") {
      injected.claimFailure = "fixture native claims";
    }
    if (defect === "source witness") {
      injected.witnessFailure = "fixture retained source";
    }
    const args = confirmationArgs(fixture);
    if (defect === "stale digest") {
      args[4] = "0".repeat(64);
    }
    if (defect === "missing confirmation flag") {
      args.splice(2, 1);
    }
    if (defect === "missing digest flag") {
      args.splice(3, 2);
    }
    const before = readFileSync(fixture.receiptPath, "utf8");
    const lockCount = injected.recoveryLocksCreated;
    const outcome = await command(fixture, args);
    expect(outcome.report).toMatchObject({
      recovered: false,
      reason: expect.stringMatching(reason),
    });
    expect(existsSync(fixture.owner.payload)).toBe(true);
    if (writesConfirmation) {
      expect(JSON.parse(readFileSync(fixture.receiptPath, "utf8"))).toMatchObject({
        operatorConfirmation: { receiptSha256: createHash("sha256").update(before).digest("hex") },
      });
      expect(existsSync(join(fixture.owner.root, "recovery.lock"))).toBe(false);
    } else {
      expect(readFileSync(fixture.receiptPath, "utf8")).toBe(before);
      expect(injected.recoveryLocksCreated).toBe(lockCount);
    }
  },
);

posixIt(
  "refuses a receipt changed during awaited live-user inspection before acquiring recovery ownership",
  async () => {
    const fixture = stage(true);
    injected.provenance = newHost;
    const args = confirmationArgs(fixture);
    let changedBytes: string | undefined;
    injected.onUsers = async () => {
      await Promise.resolve();
      rewriteReceipt(fixture, (receipt) => {
        receipt.ownerPid = Number(receipt.ownerPid) + 1;
      });
      changedBytes = readFileSync(fixture.receiptPath, "utf8");
    };
    const outcome = await command(fixture, args);
    expect(outcome.report).toMatchObject({
      recovered: false,
      reason: "staging receipt changed during live-user inspection",
    });
    expect(injected.recoveryLocksCreated).toBe(0);
    expect(readFileSync(fixture.receiptPath, "utf8")).toBe(changedBytes);
    expect(JSON.parse(changedBytes!)).not.toHaveProperty("operatorConfirmation");
    expect(existsSync(fixture.owner.payload)).toBe(true);
  },
);

posixIt(
  "retains the original pre-boot timestamp when an explicitly confirmed recovery is retried",
  async () => {
    const fixture = stage(true);
    const priorTime = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(fixture.receiptPath, priorTime, priorTime);
    injected.provenance = newHost;
    injected.bootTimeNs = BigInt(Date.parse("2001-01-01T00:00:00.000Z")) * 1_000_000n;
    const originalTime = lstatSync(fixture.receiptPath, { bigint: true }).mtimeNs;
    injected.witnessFailure = "fixture retained source not yet available";
    const first = await command(fixture, confirmationArgs(fixture));
    expect(first.report).toMatchObject({
      recovered: false,
      reason: injected.witnessFailure,
      operatorConfirmation: { receiptMtimeNs: String(originalTime) },
    });
    expect(lstatSync(fixture.receiptPath, { bigint: true }).mtimeNs).toBeGreaterThan(
      injected.bootTimeNs,
    );
    injected.witnessFailure = "";
    const unconfirmed = await command(fixture, ["recover", fixture.id]);
    expect(unconfirmed.report).toMatchObject({
      recovered: false,
      reason: expect.stringMatching(/unknown host/),
    });
    const repeated = await command(fixture, confirmationArgs(fixture));
    expect(repeated.report, repeated.report.reason).toMatchObject({
      recovered: true,
      operatorConfirmation: { receiptMtimeNs: String(originalTime) },
    });
    expect(existsSync(fixture.owner.root)).toBe(false);
  },
);

posixIt.each(["inspect", "recover"])(
  "refuses an unchanged receipt touched into the current boot during %s's user probe",
  async (operation) => {
    const fixture = stage(true);
    const beforeBoot = new Date("2000-01-01T00:00:00.000Z");
    const afterBoot = new Date("2002-01-01T00:00:00.000Z");
    utimesSync(fixture.receiptPath, beforeBoot, beforeBoot);
    injected.provenance = newHost;
    injected.bootTimeNs = BigInt(Date.parse("2001-01-01T00:00:00.000Z")) * 1_000_000n;
    const before = readFileSync(fixture.receiptPath, "utf8");
    const digest = receiptDigest(fixture);
    const args =
      operation === "inspect"
        ? ["inspect", fixture.id, "--same-host-prior-boot"]
        : confirmationArgs(fixture);
    injected.onUsers = async () => {
      await Promise.resolve();
      utimesSync(fixture.receiptPath, afterBoot, afterBoot);
    };
    const outcome = await command(fixture, args);
    expect(outcome.report).toMatchObject({
      recovered: false,
      eligible: false,
      reason: "staging receipt changed during live-user inspection",
    });
    expect(receiptDigest(fixture)).toBe(digest);
    expect(lstatSync(fixture.receiptPath, { bigint: true }).mtimeNs).toBeGreaterThan(
      injected.bootTimeNs,
    );
    expect(readFileSync(fixture.receiptPath, "utf8")).toBe(before);
    expect(injected.recoveryLocksCreated).toBe(0);
    expect(existsSync(fixture.owner.payload)).toBe(true);
  },
);

posixIt.each([
  { operation: "inspect", changed: "receipt" },
  { operation: "inspect", changed: "lock" },
  { operation: "recover", changed: "receipt" },
  { operation: "recover", changed: "lock" },
])(
  "rechecks $changed custody after final source revalidation during $operation",
  async ({ operation, changed }) => {
    const fixture = stage(true);
    injected.provenance = newHost;
    const args =
      operation === "inspect"
        ? ["inspect", fixture.id, "--same-host-prior-boot"]
        : confirmationArgs(fixture);
    const lock = join(fixture.owner.root, "recovery.lock");
    let revalidated = false;
    let changedBytes: string | undefined;
    injected.onRevalidate = () => {
      revalidated = true;
      expect(existsSync(fixture.owner.payload)).toBe(true);
      if (changed === "receipt") {
        rewriteReceipt(fixture, (receipt) => {
          receipt.ownerPid = Number(receipt.ownerPid) + 1;
        });
        changedBytes = readFileSync(fixture.receiptPath, "utf8");
      } else {
        if (operation === "inspect") {
          mkdirSync(lock);
        }
        writeFileSync(join(lock, "owner.json"), "another recovery owns this lock\n");
      }
    };
    const outcome = await command(fixture, args);
    expect(revalidated).toBe(true);
    expect(outcome.report).toMatchObject({
      recovered: false,
      eligible: false,
      reason:
        changed === "receipt"
          ? "staging ownership changed during preservation verification"
          : operation === "inspect"
            ? "Another recovery acquired this copy during inspection."
            : "staging recovery lock ownership changed",
    });
    expect(existsSync(fixture.owner.payload)).toBe(true);
    if (changed === "receipt") {
      expect(readFileSync(fixture.receiptPath, "utf8")).toBe(changedBytes);
    } else {
      expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(
        "another recovery owns this lock\n",
      );
    }
  },
);
