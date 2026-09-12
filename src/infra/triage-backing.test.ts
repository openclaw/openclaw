import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import * as processIdentityProbe from "../shared/pid-alive.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { captureTriageBackingReference, observeTriageBacking } from "./triage-backing.js";
import { continueTriageInFreshProcess } from "./triage-continuation.js";
import { triageTestRuntimeEntrypoints } from "./triage-runtime.test-support.js";
import * as databaseIdentityProbe from "./update-managed-service-handoff-database.js";
import { captureManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).toReversed()) {
    await fn();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
async function fixture() {
  const root = fs.realpathSync(dirs.make("triage-backing-"));
  fs.chmodSync(root, 0o700);
  const databasePath = path.join(root, "lease.sqlite");
  const store = createManagedHandoffLeaseStore({
    databasePath,
    serviceManagerEnv: resolveServiceManagerEnv(),
  });
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  cleanup.push(async () => {
    child.stdin.end();
    await exited;
  });
  const acquired = store.acquire(root, "original-owner", {
    kind: "triage",
    phase: "reserved",
    lifetime: { kind: "foreground", boot: store.bootIdentity() },
  });
  if (acquired.kind !== "acquired") {
    throw new Error("fixture admission failed");
  }
  const bound = store.bind(acquired.lease, child.pid!);
  if (!bound) {
    throw new Error("fixture bind failed");
  }
  const lease = store.activate(bound);
  if (!lease) {
    throw new Error("fixture activation failed");
  }
  const identity = captureManagedUpdateLeaseDatabaseIdentity(databasePath);
  const reference = captureTriageBackingReference(lease, identity);
  const write = (sql: string, ...args: Array<string | number>) => {
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare(sql).run(...args);
    } finally {
      db.close();
    }
  };
  return { root, databasePath, store, lease, reference, write, child, exited };
}

it("observes a real admitted foreign executor without granting ownership or writing bytes", async () => {
  const f = await fixture();
  const before = hash(f.databasePath),
    entries = fs.readdirSync(f.root);
  expect(f.store.owns(f.lease, "executor")).toBe(false);
  expect(observeTriageBacking(f.reference)).toEqual({
    kind: "matched",
    phase: "running",
    helper: "live",
    executor: "live",
    lifetime: "matched",
    control: "unavailable",
  });
  expect(hash(f.databasePath)).toBe(before);
  expect(fs.readdirSync(f.root)).toEqual(entries);
  expect(Object.isFrozen(f.reference.generation.lifetime)).toBe(true);
});

it("retains closing and uncertain as observed phases without releasing the generation", async () => {
  const f = await fixture();
  const closing = f.store.settle(f.lease, "closing");
  expect(closing).not.toBeNull();
  expect(observeTriageBacking(f.reference)).toMatchObject({ kind: "matched", phase: "closing" });
  const uncertain = f.store.settle(closing!, "uncertain");
  expect(uncertain).not.toBeNull();
  expect(observeTriageBacking(f.reference)).toMatchObject({ kind: "matched", phase: "uncertain" });
  expect(f.store.read(f.root).kind).toBe("current");
});

it("distinguishes absent from replacement and unreadable rows", async () => {
  const f = await fixture();
  f.write(
    "UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?",
    "replacement",
    f.root,
  );
  expect(observeTriageBacking(f.reference)).toEqual({
    kind: "different-generation",
    reason: "generation-changed",
  });
  f.write(
    "UPDATE managed_update_handoffs SET payload_json = ? WHERE install_root = ?",
    "{}",
    f.root,
  );
  expect(observeTriageBacking(f.reference)).toEqual({
    kind: "unavailable",
    reason: "unreadable-row",
  });
  f.write("DELETE FROM managed_update_handoffs WHERE install_root = ?", f.root);
  expect(observeTriageBacking(f.reference)).toEqual({ kind: "absent", reason: "missing-row" });
});

it("refuses copied database and parent identities without provisioning missing storage", async () => {
  const f = await fixture();
  const saved = path.join(f.root, "saved.sqlite");
  fs.renameSync(f.databasePath, saved);
  fs.copyFileSync(saved, f.databasePath);
  expect(observeTriageBacking(f.reference)).toMatchObject({
    kind: "unavailable",
    reason: "identity-unavailable",
  });
  fs.unlinkSync(f.databasePath);
  expect(observeTriageBacking(f.reference).kind).toBe("unavailable");
  expect(fs.existsSync(f.databasePath)).toBe(false);
  fs.renameSync(saved, f.databasePath);
  const parentCopy = {
    ...f.reference,
    leaseDatabase: { ...f.reference.leaseDatabase, parentIdentity: "1:2" },
  };
  expect(observeTriageBacking(parentCopy)).toMatchObject({
    kind: "unavailable",
    reason: "identity-unavailable",
  });
});

it("does not classify a dead executor or mismatched boot as successful completion", async () => {
  const f = await fixture();
  f.child.stdin.end();
  await f.exited;
  expect(observeTriageBacking(f.reference)).toMatchObject({
    kind: "matched",
    executor: "dead",
    control: "unavailable",
  });
  const payload = JSON.parse(f.lease.payload);
  if (payload.action.lifetime.boot.platform === "win32") {
    payload.action.lifetime.boot.identity = "2000-01-01T00:00:00.0000000Z";
  } else {
    payload.action.lifetime.boot.identity = "00000000-0000-0000-0000-000000000000";
  }
  f.write(
    "UPDATE managed_update_handoffs SET payload_json = ? WHERE install_root = ?",
    JSON.stringify(payload),
    f.root,
  );
  const reference = {
    ...f.reference,
    generation: { ...f.reference.generation, lifetime: payload.action.lifetime },
  };
  expect(observeTriageBacking(reference)).toMatchObject({
    kind: "matched",
    lifetime: "mismatch",
    control: "unavailable",
  });
  expect(f.store.read(f.root).kind).toBe("current");
});

it("rejects invalid data and never turns a reservation into backing", async () => {
  const f = await fixture();
  expect(observeTriageBacking({ ...f.reference, extra: true })).toMatchObject({
    kind: "unavailable",
    reason: "invalid-reference",
  });
  expect(
    observeTriageBacking({
      ...f.reference,
      generation: { ...f.reference.generation, executor: f.reference.generation.helper },
    }).kind,
  ).toBe("unavailable");
  expect(() =>
    captureTriageBackingReference(
      { ...f.lease, action: { kind: "update" } },
      f.reference.leaseDatabase,
    ),
  ).toThrow();
});

it("refuses a row changed during real process probes", async () => {
  const f = await fixture();
  const original = process.kill.bind(process);
  let changed = false;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (!changed && signal === 0) {
      changed = true;
      f.write(
        "UPDATE managed_update_handoffs SET updated_at = updated_at + 1 WHERE install_root = ?",
        f.root,
      );
    }
    return original(pid, signal);
  });
  expect(observeTriageBacking(f.reference)).toEqual({
    kind: "unavailable",
    reason: "observation-changed",
  });
});

it.each([false, true])(
  "captures backing only on successful real IPC admission with changed ambient=%s",
  async (changeAmbient) => {
    const root = fs.realpathSync(dirs.make("triage-backing-ipc-"));
    const continuation = resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.continuation);
    const candidate = path.join(root, "candidate.mjs");
    const observed = path.join(root, "backing.json"),
      release = path.join(root, "release");
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","type":"module"}');
    fs.writeFileSync(
      path.join(root, "dist/index.js"),
      `await import(${JSON.stringify(candidate)});`,
    );
    fs.writeFileSync(
      candidate,
      `
import fs from 'node:fs';
import {acceptTriageContinuation} from ${JSON.stringify(continuation.href)};
${changeAmbient ? `process.once('message',()=>{process.env.TMPDIR=${JSON.stringify(root)};process.env.OPENCLAW_STATE_DIR=${JSON.stringify(path.join(root, "other-profile"))};});` : ""}
const admitted = await acceptTriageContinuation();
admitted.assertCurrent();
fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify(admitted.backing ?? null));
await new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}) || admitted.signal.aborted){clearInterval(timer);resolve();}},10);});
await admitted.finish('closed');
`,
    );
    const controller = new AbortController();
    const run = continueTriageInFreshProcess({
      root,
      commandArgv: [process.execPath, path.join(root, "dist/index.js"), "triage"],
      operator: { kind: "operator", installationRoot: root, gateway: "preserve" },
      signal: controller.signal,
      output: () => {},
    });
    // Keep the actual loader contract for source and prepared-runtime test modes.
    const result = run.catch((error: unknown) => {
      throw error;
    });
    try {
      await vi.waitFor(() => expect(fs.existsSync(observed)).toBe(true), { timeout: 25000 });
      const reference: unknown = JSON.parse(fs.readFileSync(observed, "utf8"));
      expect(reference).not.toBeNull();
      expect(observeTriageBacking(reference)).toMatchObject({
        kind: "matched",
        phase: "running",
        helper: "live",
        executor: "live",
      });
      fs.writeFileSync(release, "");
      expect(await result).toMatchObject({ status: "completed" });
      expect(observeTriageBacking(reference)).toEqual({ kind: "absent", reason: "missing-row" });
    } finally {
      fs.writeFileSync(release, "");
      controller.abort();
      await result.catch(() => {});
    }
  },
  40000,
);

it("reports an unavailable start probe without declaring the live owner dead", async () => {
  const f = await fixture();
  vi.spyOn(processIdentityProbe, "getFileLockProcessStartTime").mockReturnValue(null);
  expect(observeTriageBacking(f.reference)).toMatchObject({
    kind: "matched",
    helper: "unknown",
    executor: "unknown",
    control: "unavailable",
  });
});

it("refuses database replacement during process observation", async () => {
  const f = await fixture();
  const original = process.kill.bind(process);
  let changed = false;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (!changed && signal === 0) {
      changed = true;
      fs.renameSync(f.databasePath, f.databasePath + ".saved");
      fs.copyFileSync(f.databasePath + ".saved", f.databasePath);
    }
    return original(pid, signal);
  });
  expect(observeTriageBacking(f.reference)).toEqual({
    kind: "unavailable",
    reason: "identity-unavailable",
  });
});

it.skipIf(process.platform === "win32")(
  "checks the native scope invocation, not ActiveState alone",
  async () => {
    const f = await fixture();
    const bin = path.join(f.root, "bin");
    fs.mkdirSync(bin);
    const properties = path.join(f.root, "scope.txt");
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      `#!${process.execPath}\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(properties)},'utf8'));\n`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", bin + path.delimiter + (process.env.PATH ?? ""));
    const lifetime = {
      kind: "native",
      unit: "owner.service",
      scope: "triage.scope",
      placement: { kind: "attached", invocation: "a".repeat(32) },
    };
    const payload = JSON.parse(f.lease.payload);
    payload.action.lifetime = lifetime;
    f.write(
      "UPDATE managed_update_handoffs SET payload_json = ? WHERE install_root = ?",
      JSON.stringify(payload),
      f.root,
    );
    const reference = { ...f.reference, generation: { ...f.reference.generation, lifetime } };
    fs.writeFileSync(
      properties,
      `Id=triage.scope\nLoadState=loaded\nActiveState=active\nInvocationID=${"a".repeat(32)}\nControlGroup=/synthetic/triage.scope\n`,
    );
    expect(observeTriageBacking(reference)).toMatchObject({ kind: "matched", lifetime: "matched" });
    fs.writeFileSync(
      properties,
      `Id=triage.scope\nLoadState=loaded\nActiveState=active\nInvocationID=${"b".repeat(32)}\nControlGroup=/synthetic/triage.scope\n`,
    );
    expect(observeTriageBacking(reference)).toMatchObject({
      kind: "matched",
      lifetime: "mismatch",
    });
    fs.writeFileSync(path.join(bin, "systemctl"), `#!${process.execPath}\nprocess.exitCode=1;\n`, {
      mode: 0o700,
    });
    expect(observeTriageBacking(reference)).toMatchObject({
      kind: "matched",
      lifetime: "unavailable",
    });
  },
);

it("reobserves the captured generation in a fresh process with no local run callbacks", async () => {
  const f = await fixture();
  const moduleUrl = resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "triage-backing",
    distWorkerPath: "infra/triage-backing.js",
  });
  const observer = path.join(
    f.root,
    moduleUrl.pathname.endsWith(".ts") ? "observer.mts" : "observer.mjs",
  );
  fs.writeFileSync(
    observer,
    `
    import {observeTriageBacking} from ${JSON.stringify(moduleUrl.href)};
    process.stdout.write(JSON.stringify(observeTriageBacking(${JSON.stringify(f.reference)})));
  `,
  );
  const result = execFileSync(process.execPath, resolveRuntimeWorkerArgv(pathToFileURL(observer)), {
    encoding: "utf8",
    timeout: 15000,
  });
  expect(JSON.parse(result)).toEqual({
    kind: "matched",
    phase: "running",
    helper: "live",
    executor: "live",
    lifetime: "matched",
    control: "unavailable",
  });
});

it("contains the reviewer identity race between the initial assertion and first read", async () => {
  const f = await fixture();
  const original = databaseIdentityProbe.assertManagedUpdateLeaseDatabaseIdentity;
  let changed = false;
  vi.spyOn(databaseIdentityProbe, "assertManagedUpdateLeaseDatabaseIdentity").mockImplementation(
    (binding) => {
      original(binding);
      if (!changed) {
        changed = true;
        fs.renameSync(f.databasePath, f.databasePath + ".saved");
        fs.copyFileSync(f.databasePath + ".saved", f.databasePath);
      }
    },
  );
  expect(observeTriageBacking(f.reference)).toEqual({
    kind: "unavailable",
    reason: "unreadable-row",
  });
});

it("refuses oversized identity DATA rather than truncating it", async () => {
  const f = await fixture();
  expect(
    observeTriageBacking({
      ...f.reference,
      leaseDatabase: { ...f.reference.leaseDatabase, databaseIdentity: "1".repeat(129) + ":2" },
    }),
  ).toEqual({ kind: "unavailable", reason: "invalid-reference" });
});

// Current main distinguishes a never-initialized store from a broken admitted database.
it.each(["empty", "unrelated-schema"] as const)(
  "current-main schema loss remains unavailable for pinned backing: %s",
  async (shape) => {
    const f = await fixture();
    f.write("DROP TABLE managed_update_handoffs");
    if (shape === "unrelated-schema") {
      f.write("CREATE TABLE unrelated(value TEXT)");
    }
    const before = hash(f.databasePath);
    const entries = fs.readdirSync(f.root);
    // Ordinary discovery may classify only a wholly empty schema as absent.
    expect(f.store.read(f.root).kind).toBe(shape === "empty" ? "absent" : "unreadable");
    const pinned = createManagedHandoffLeaseStore({
      databasePath: f.databasePath,
      existingIdentity: f.reference.leaseDatabase,
      serviceManagerEnv: resolveServiceManagerEnv(),
    });
    expect(pinned.read(f.root).kind).toBe("unreadable");
    expect(pinned.readGeneration(f.lease)).toBeNull();
    expect(observeTriageBacking(f.reference)).toEqual({
      kind: "unavailable",
      reason: "unreadable-row",
    });
    expect(hash(f.databasePath)).toBe(before);
    expect(fs.readdirSync(f.root)).toEqual(entries);
  },
);
