import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessageChannel, receiveMessageOnPort, type Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { publishOpenClawStateDatabaseWorkerAdmission } from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { readProfileAuthority } from "../state/user-profile-authority.js";
import {
  captureUserProfileAuthorityRead,
  fenceUserProfileMutationAuthority,
} from "../state/user-profile-events.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { SqliteWorkerSlotCustody } from "./sqlite-worker-request-custody.js";
import { assertSqliteWriterBrokerAdmission } from "./sqlite-writer-admission-client.js";
import { createSqliteWriterAdmissionService } from "./sqlite-writer-admission-service.js";
import * as workerCpu from "./worker-cpu.js";

const paths: string[] = [];
const services: ReturnType<typeof createSqliteWriterAdmissionService>[] = [];
function service() {
  const owner = createSqliteWriterAdmissionService();
  services.push(owner);
  return owner;
}
const roots = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(services.splice(0).map((owner) => owner.close()));
    for (const pathname of paths.splice(0)) {
      await closeOpenClawStateDatabaseByPathAsync(pathname);
    }
    await drainGlobalSingletonLifecycleState("close");
    cleanup();
  });
});

async function fixture() {
  const options = { path: path.join(roots.make("profile-admission-"), "openclaw.sqlite") };
  paths.push(options.path);
  const profile = ensureProfileForEmail("person@example.test", options);
  const context = captureOpenClawStateWorkerContext(options);
  const authority = await captureUserProfileAuthorityRead(context.admission);
  const bound = authority.bind(profile.id)!;
  return { options, profile, context, authority, bound };
}

it("checks broker custody through a direct worker port while its host cannot run callbacks", async () => {
  const owner = service();
  const connection = await owner.connect();
  const slot = new SqliteWorkerSlotCustody();
  const current = slot.createRequest();
  current.activate();
  current.accept();
  try {
    // The synchronous waiter blocks this host; only the service worker can answer.
    assertSqliteWriterBrokerAdmission(connection, current.descriptor);
    current.cancel();
    assertSqliteWriterBrokerAdmission(connection, current.descriptor);
    current.retire();
    const successor = slot.createRequest();
    successor.activate();
    assertSqliteWriterBrokerAdmission(connection, successor.descriptor);
    expect(() =>
      assertSqliteWriterBrokerAdmission(connection, structuredClone(current.descriptor)),
    ).toThrow("revoked");
    slot.retire();
    expect(() => assertSqliteWriterBrokerAdmission(connection, successor.descriptor)).toThrow(
      "revoked",
    );
    const closing = owner.close();
    expect(Atomics.load(connection.lifetime, 0)).toBe(0);
    await closing;
  } finally {
    connection.port.close();
  }
});

it("expires a lost native-to-service request without relying on host scheduling or reviving it", () => {
  const { port1, port2 } = new MessageChannel();
  const lifetime = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.store(lifetime, 0, 1);
  const custody = new SqliteWorkerSlotCustody().createRequest();
  custody.activate();
  let now = 0n;
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
  const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => {
    now += 31_000_000_000n;
    return "timed-out";
  });
  try {
    expect(() =>
      assertSqliteWriterBrokerAdmission({ port: port2, lifetime }, custody.descriptor),
    ).toThrow(expect.objectContaining({ code: "admission-timeout" }));
    expect(wait).toHaveBeenCalledOnce();
    const late: unknown = receiveMessageOnPort(port1)?.message;
    if (!isRecord(late) || !(late.decision instanceof Int32Array)) {
      throw new Error("Missing expired admission decision");
    }
    expect(late.decision).toBeInstanceOf(Int32Array);
    expect(Atomics.compareExchange(late.decision, 0, 0, 1)).toBe(3);
    expect(Atomics.load(late.decision, 0)).toBe(3);
    expect(custody.dispatched).toBe(false);
  } finally {
    port1.close();
    port2.close();
  }
});

it("does not revive a connection after service crash and restart", async () => {
  const workers: Worker[] = [];
  const createWorker = workerCpu.createCpuTrackedWorker;
  vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((url, options) => {
    const worker = createWorker(url, options);
    workers.push(worker);
    return worker;
  });
  const owner = service();
  const previous = await owner.connect();
  const custody = new SqliteWorkerSlotCustody().createRequest();
  custody.activate();
  const worker = workers[0];
  if (!worker) {
    throw new Error("Service worker was not created");
  }
  await worker.terminate();
  await owner.close();
  const replacement = await service().connect();
  try {
    expect(() => assertSqliteWriterBrokerAdmission(previous, custody.descriptor)).toThrow(
      "revoked",
    );
    assertSqliteWriterBrokerAdmission(replacement, custody.descriptor);
    expect(replacement.lifetime.buffer).not.toBe(previous.lifetime.buffer);
  } finally {
    previous.port.close();
    replacement.port.close();
  }
});

it("sees revocation after dispatch and rejects late registration after retirement", async () => {
  const { options, profile, context, authority, bound } = await fixture();
  const owner = service();
  const exact = { kind: "assert-bound-revision", authority: bound.transferable } as const;
  const current = {
    kind: "read-current-settled-facts",
    authority: authority.transferSettled(profile.id),
  } as const;
  const gate = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
  const createWorker = workerCpu.createCpuTrackedWorker;
  const pause = vi
    .spyOn(workerCpu, "createCpuTrackedWorker")
    .mockImplementation((url, workerOptions) => {
      const entry = new URL(
        `data:text/javascript,${encodeURIComponent(`
      import { workerData } from "node:worker_threads";
      const gate = new Int32Array(workerData.admissionGate);
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      Atomics.wait(gate, 1, 0);
      await import(${JSON.stringify(String(url))});
    `)}`,
      );
      return createWorker(entry, {
        ...workerOptions,
        workerData: { ...workerOptions?.workerData, admissionGate: gate.buffer },
      });
    });
  const decision = owner.read(exact);
  void decision.catch(() => undefined);
  await Atomics.waitAsync(gate, 0, 0).value;
  const mutation = fenceUserProfileMutationAuthority(context.admission, {
    profiles: [profile.id],
    identities: [],
    channels: [],
  });
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
  pause.mockRestore();
  await expect(decision).resolves.toBe("revoked");
  await expect(owner.read(current)).resolves.toBe("pending");
  mutation.settle(true);
  await expect(owner.read(current)).resolves.toBe("current");
  await expect(owner.read(exact)).resolves.toBe("revoked");

  await closeOpenClawStateDatabaseByPathAsync(options.path);
  openOpenClawStateDatabase(options);
  await expect(owner.read(structuredClone(current))).resolves.toBe("revoked");
});

it("settles a crashed service request before starting fresh work without reviving retired authority", async () => {
  const { options, context, profile, authority } = await fixture();
  const request = {
    kind: "read-current-settled-facts",
    authority: authority.transferSettled(profile.id),
  } as const;
  const failed = service();
  const createWorker = workerCpu.createCpuTrackedWorker;
  const crash = vi
    .spyOn(workerCpu, "createCpuTrackedWorker")
    .mockImplementation((url, workerOptions) => {
      const worker = createWorker(url, workerOptions);
      worker.once("online", () => {
        void worker.terminate();
      });
      return worker;
    });
  await expect(failed.read(request)).rejects.toThrow();
  crash.mockRestore();
  await failed.close();
  const restarted = service();
  const mutation = fenceUserProfileMutationAuthority(context.admission, {
    profiles: [profile.id],
    identities: [],
    channels: [],
  });
  mutation.settle(false);
  await expect(restarted.read(request)).resolves.toBe("uncertain");
  await closeOpenClawStateDatabaseByPathAsync(options.path);
  await expect(restarted.read(request)).resolves.toBe("revoked");
});

it("revokes worker-only storage before asynchronous drainage and keeps old descriptors retired", async () => {
  const options = { path: path.join(roots.make("profile-worker-only-"), "openclaw.sqlite") };
  paths.push(options.path);
  const context = captureOpenClawStateWorkerContext(options);
  const precreation = await captureUserProfileAuthorityRead(context.admission);
  const previous = {
    kind: "assert-bound-revision",
    authority: precreation.bind("synthetic-profile")!.transferable,
  } as const;
  const owner = service();
  await expect(owner.read(previous)).resolves.toBe("current");
  new DatabaseSync(options.path).close();
  publishOpenClawStateDatabaseWorkerAdmission(context.admission);
  expect(readProfileAuthority(previous.authority)).toBe("revoked");
  await expect(owner.read(previous)).resolves.toBe("revoked");
  const authority = await captureUserProfileAuthorityRead(context.admission);
  const request = {
    kind: "assert-bound-revision",
    authority: authority.bind("synthetic-profile")!.transferable,
  } as const;
  await expect(owner.read(request)).resolves.toBe("current");

  const closing = closeOpenClawStateDatabaseByPathAsync(options.path);
  expect(readProfileAuthority(request.authority)).toBe("revoked");
  await expect(owner.read(request)).resolves.toBe("revoked");
  await closing;
  const reopened = await captureUserProfileAuthorityRead(
    captureOpenClawStateWorkerContext(options).admission,
  );
  await expect(
    owner.read({
      kind: "assert-bound-revision",
      authority: reopened.bind("synthetic-profile")!.transferable,
    }),
  ).resolves.toBe("current");
  await expect(owner.read(structuredClone(request))).resolves.toBe("revoked");
});
