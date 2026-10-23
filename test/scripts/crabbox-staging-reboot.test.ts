import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
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
  fs.mkdirSync(repository);
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
  fs.mkdirSync(join(owner.payload, "source"));
  owner.prepared(
    { files: [], deleted: [] },
    {
      gitDir: join(repository, ".git"),
      ref: "refs/openclaw/source-fixture",
      commit: "1".repeat(40),
    },
  );
  const receiptPath = join(owner.root, "staging.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  if (legacy) {
    delete receipt.ownerProvenance;
    delete receipt.syncRootIdentity;
    receipt.ownerDomain = processDomain(oldHost);
    fs.writeFileSync(receiptPath, JSON.stringify(receipt) + "\n");
    injected.provenance = newHost;
  }
  return {
    syncRoot,
    owner,
    receiptPath,
    id: String(receipt.id),
    read: () => fs.readFileSync(receiptPath, "utf8"),
    stat: () => fs.lstatSync(receiptPath, { bigint: true }),
    file: (name: string) => join(owner.root, name),
    touch: (date: Date) => fs.utimesSync(receiptPath, date, date),
  };
}
type Fixture = ReturnType<typeof stage>;
function digest(bytes: string) {
  return createHash("sha256").update(bytes).digest("hex");
}
function rewriteReceipt(fixture: Fixture, change: (receipt: Record<string, unknown>) => void) {
  const receipt = JSON.parse(fixture.read());
  change(receipt);
  fs.writeFileSync(fixture.receiptPath, JSON.stringify(receipt) + "\n");
}
function inspectionArgs(fixture: Fixture, operation: string) {
  return operation === "inspect"
    ? ["inspect", fixture.id, "--same-host-prior-boot"]
    : confirmationArgs(fixture);
}
function expectRetained(fixture: Fixture, before?: string, locks?: number) {
  expect(fs.existsSync(fixture.owner.payload)).toBe(true);
  if (before !== undefined) {
    expect(fixture.read()).toBe(before);
  }
  if (locks !== undefined) {
    expect(injected.recoveryLocksCreated).toBe(locks);
  }
}
function preBoot(fixture: Fixture) {
  fixture.touch(new Date("2000-01-01T00:00:00.000Z"));
  const bootTimeNs = BigInt(Date.parse("2001-01-01T00:00:00.000Z")) * 1_000_000n;
  injected.bootTimeNs = bootTimeNs;
  return bootTimeNs;
}
function confirmationArgs(fixture: Fixture) {
  return [
    "recover",
    fixture.id,
    "--confirm-same-host-prior-boot",
    "--receipt-sha256",
    digest(fixture.read()),
  ];
}
async function command(fixture: Fixture, args: string[]) {
  // Volume lookups coalesce within one synchronous turn; recovery starts a new one.
  await Promise.resolve();
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await runStagingCommand(args, fixture.syncRoot, {
      binary: "unused-crabbox",
      cwd: repository,
    });
    return JSON.parse(output.mock.calls.at(-1)![0]);
  } finally {
    output.mockRestore();
  }
}
async function refused(fixture: Fixture, args: string[], reason: string | RegExp, extra = {}) {
  expect(await command(fixture, args)).toMatchObject({
    recovered: false,
    reason: typeof reason === "string" ? reason : expect.stringMatching(reason),
    ...extra,
  });
}
function changeOwner(fixture: Fixture) {
  rewriteReceipt(fixture, (receipt) => {
    receipt.ownerPid = Number(receipt.ownerPid) + 1;
  });
  return fixture.read();
}

posixIt("records provenance; same-host reboot recovery never probes reused PID", async () => {
  const fixture = stage();
  const stored = JSON.parse(fixture.read());
  expect(stored).toMatchObject({
    ownerPid: process.pid,
    ownerProvenance: oldHost,
    syncRootIdentity: { stable: { volume: "uuid:" + oldHost.hostId } },
  });
  injected.provenance = newHost;
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  expect(await command(fixture, ["recover", fixture.id])).toMatchObject({ recovered: true });
  expect(kill.mock.calls.filter(([, signal]) => signal === 0)).toEqual([]);
  expect(fs.existsSync(fixture.owner.root)).toBe(false);
});

const namespaceHost = { ...oldHost, platform: "linux" as const, hostId: "1".repeat(32) };
posixIt.each([
  ["different host", oldHost, { ...newHost, hostId: "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee" }],
  [
    "different namespace",
    { ...namespaceHost, pidNamespace: "pid:[4026531836]" },
    { ...namespaceHost, bootId: newHost.bootId, pidNamespace: "pid:[4026531837]" },
  ],
  ["missing provenance", oldHost, newHost],
] satisfies [string, ProcessProvenance, ProcessProvenance][])(
  "refuses %s as proof of producer death",
  async (defect, previous, current) => {
    injected.provenance = previous;
    const fixture = stage();
    injected.provenance = current;
    if (defect === "missing provenance") {
      rewriteReceipt(fixture, (receipt) => {
        delete receipt.ownerProvenance;
        delete receipt.ownerDomain;
      });
    }
    const before = fixture.read();
    await refused(fixture, ["recover", fixture.id], /host|namespace/);
    expect(fixture.read()).toBe(before);
    expect(injected.recoveryLocksCreated).toBe(0);
  },
);

posixIt("previews read-only; persists receipt-bound confirmation before removal", async () => {
  const fixture = stage(true);
  const before = fixture.read();
  const beforeStat = fixture.stat();
  const beforeFiles = fs.readdirSync(fixture.owner.root).toSorted();
  injected.onUsers = () => {
    expect(fs.existsSync(fixture.file("recovery.lock"))).toBe(false);
  };
  const preview = await command(fixture, ["inspect", fixture.id, "--same-host-prior-boot"]);
  expect(preview).toMatchObject({
    eligible: true,
    inspectionOnly: true,
    confirmationRequired: true,
    receiptSha256: digest(fixture.read()),
  });
  expect(fixture.read()).toBe(before);
  expect(fixture.stat().mtimeNs).toBe(beforeStat.mtimeNs);
  expect(fs.readdirSync(fixture.owner.root).toSorted()).toEqual(beforeFiles);
  expect(injected.recoveryLocksCreated).toBe(0);
  injected.onUsers = undefined;
  let observedConfirmation: unknown;
  injected.beforeRemove = (path) => {
    if (path === fixture.owner.payload) {
      observedConfirmation = JSON.parse(fixture.read()).operatorConfirmation;
    }
  };
  const args = confirmationArgs(fixture);
  args[4] = preview.receiptSha256;
  const recovered = await command(fixture, args);
  expect(recovered).toMatchObject({
    recovered: true,
    operatorConfirmation: {
      kind: "same-host-prior-boot",
      receiptSha256: preview.receiptSha256,
      receiptMtimeNs: String(beforeStat.mtimeNs),
      current: newHost,
    },
  });
  expect(observedConfirmation).toEqual(recovered.operatorConfirmation);
  expect(fs.existsSync(fixture.owner.root)).toBe(false);
});

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
    const overrides: Record<string, Partial<typeof injected>> = {
      "unavailable current provenance": { provenance: undefined },
      "unavailable current boot time": { bootTimeNs: undefined },
      "changed inode": { changedInodePath: fixture.owner.root },
      "changed volume": { volume: "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
      "unavailable volume UUID": { volume: undefined },
      "live users": { userFailure: "fixture live staging user" },
      "unavailable lsof": { userFailure: "fixture unavailable user census" },
      "native claims": { claimFailure: "fixture native claims" },
      "source witness": { witnessFailure: "fixture retained source" },
    };
    Object.assign(injected, overrides[defect]);
    if (defect === "same-boot digest") {
      rewriteReceipt(fixture, (receipt) => {
        receipt.ownerDomain = processDomain(newHost);
      });
    }
    if (defect === "receipt at boot time" || defect === "receipt after boot time") {
      injected.bootTimeNs =
        fixture.stat().mtimeNs - (defect === "receipt after boot time" ? 1n : 0n);
    }
    if (defect === "missing required metadata") {
      rewriteReceipt(fixture, (receipt) => {
        delete receipt.rootIdentity;
      });
    }
    if (defect === "missing manifest") {
      fs.rmSync(fixture.file("manifest.json"));
    }
    if (defect === "manifest mismatch") {
      fs.writeFileSync(fixture.file("manifest.json"), "{}\n");
    }
    if (defect === "existing recovery lock") {
      fs.mkdirSync(fixture.file("recovery.lock"));
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
    const before = fixture.read();
    const lockCount = injected.recoveryLocksCreated;
    await refused(fixture, args, reason);
    expectRetained(fixture);
    if (writesConfirmation) {
      expect(JSON.parse(fixture.read())).toMatchObject({
        operatorConfirmation: { receiptSha256: digest(before) },
      });
      expect(fs.existsSync(fixture.file("recovery.lock"))).toBe(false);
    } else {
      expectRetained(fixture, before, lockCount);
    }
  },
);

posixIt("rejects receipt changes during awaited user inspection", async () => {
  const fixture = stage(true);
  const args = confirmationArgs(fixture);
  let changedBytes: string | undefined;
  injected.onUsers = async () => {
    await Promise.resolve();
    changedBytes = changeOwner(fixture);
  };
  await refused(fixture, args, "staging receipt changed during live-user inspection");
  expectRetained(fixture, changedBytes, 0);
  expect(JSON.parse(changedBytes!)).not.toHaveProperty("operatorConfirmation");
});

posixIt("retains the pre-boot timestamp across confirmed recovery retries", async () => {
  const fixture = stage(true);
  const bootTimeNs = preBoot(fixture);
  const originalTime = fixture.stat().mtimeNs;
  injected.witnessFailure = "fixture retained source not yet available";
  const first = await command(fixture, confirmationArgs(fixture));
  expect(first).toMatchObject({
    recovered: false,
    reason: injected.witnessFailure,
    operatorConfirmation: { receiptMtimeNs: String(originalTime) },
  });
  expect(fixture.stat().mtimeNs).toBeGreaterThan(bootTimeNs);
  injected.witnessFailure = "";
  await refused(fixture, ["recover", fixture.id], /unknown host/);
  const repeated = await command(fixture, confirmationArgs(fixture));
  expect(repeated).toMatchObject({
    recovered: true,
    operatorConfirmation: { receiptMtimeNs: String(originalTime) },
  });
  expect(fs.existsSync(fixture.owner.root)).toBe(false);
});

posixIt.each(["inspect", "recover"])(
  "refuses an unchanged receipt touched into the current boot during %s's user probe",
  async (operation) => {
    const fixture = stage(true);
    const bootTimeNs = preBoot(fixture);
    const before = fixture.read();
    const originalDigest = digest(fixture.read());
    const args = inspectionArgs(fixture, operation);
    injected.onUsers = async () => {
      await Promise.resolve();
      fixture.touch(new Date("2002-01-01T00:00:00.000Z"));
    };
    await refused(fixture, args, "staging receipt changed during live-user inspection", {
      eligible: false,
    });
    expect(digest(fixture.read())).toBe(originalDigest);
    expect(fixture.stat().mtimeNs).toBeGreaterThan(bootTimeNs);
    expectRetained(fixture, before, 0);
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
    const args = inspectionArgs(fixture, operation);
    const lock = fixture.file("recovery.lock");
    let revalidated = false;
    let changedBytes: string | undefined;
    injected.onRevalidate = () => {
      revalidated = true;
      expect(fs.existsSync(fixture.owner.payload)).toBe(true);
      if (changed === "receipt") {
        changedBytes = changeOwner(fixture);
      } else {
        if (operation === "inspect") {
          fs.mkdirSync(lock);
        }
        fs.writeFileSync(join(lock, "owner.json"), "another recovery owns this lock\n");
      }
    };
    const outcome = await command(fixture, args);
    expect(revalidated).toBe(true);
    expect(outcome).toMatchObject({
      recovered: false,
      eligible: false,
      reason:
        changed === "receipt"
          ? "staging ownership changed during preservation verification"
          : operation === "inspect"
            ? "Another recovery acquired this copy during inspection."
            : "staging recovery lock ownership changed",
    });
    expectRetained(fixture);
    if (changed === "receipt") {
      expect(fixture.read()).toBe(changedBytes);
    } else {
      expect(fs.readFileSync(join(lock, "owner.json"), "utf8")).toBe(
        "another recovery owns this lock\n",
      );
    }
  },
);
