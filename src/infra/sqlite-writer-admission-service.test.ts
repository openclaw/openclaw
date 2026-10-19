import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { publishOpenClawStateDatabaseWorkerAdmission as publishAdmission } from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseByPathAsync as closeDatabase,
  openOpenClawStateDatabase as openDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext as captureContext } from "../state/openclaw-state-worker-context.js";
import { readProfileAuthority } from "../state/user-profile-authority.js";
import {
  captureUserProfileAuthorityRead as captureAuthority,
  fenceUserProfileMutationAuthority as fenceMutation,
} from "../state/user-profile-events.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { SqliteWorkerSlotCustody } from "./sqlite-worker-request-custody.js";
import {
  assertSqliteWriterBrokerAdmission as assertAdmission,
  createSqliteWriterAdmissionService as createService,
} from "./sqlite-writer-admission-service.test-support.js";
import * as workerCpu from "./worker-cpu.js";

const paths: string[] = [];
const services: ReturnType<typeof createService>[] = [];
function service() {
  const owner = createService();
  services.push(owner);
  return owner;
}
const roots = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(services.splice(0).map((owner) => owner.close()));
    for (const pathname of paths.splice(0)) {
      await closeDatabase(pathname);
    }
    await drainGlobalSingletonLifecycleState("close");
    cleanup();
  });
});

async function fixture() {
  const options = storage("profile-admission-");
  const profile = ensureProfileForEmail("person@example.test", options);
  const context = captureContext(options);
  const authority = await captureAuthority(context.admission);
  const targets = { profiles: [profile.id], identities: [], channels: [] };
  return {
    options,
    exact: boundRequest(authority, profile.id),
    current: {
      kind: "read-current-settled-facts",
      authority: authority.transferSettled(profile.id),
    } as const,
    mutate: () => fenceMutation(context.admission, targets),
  };
}

function storage(prefix: string) {
  const options = { path: path.join(roots.make(prefix), "openclaw.sqlite") };
  paths.push(options.path);
  return options;
}

type Authority = Awaited<ReturnType<typeof captureAuthority>>;
const boundRequest = (authority: Authority, id = "synthetic-profile") => ({
  kind: "assert-bound-revision" as const,
  authority: authority.bind(id)!.transferable,
});

function activeRequest(slot = new SqliteWorkerSlotCustody()) {
  const request = slot.createRequest();
  request.activate();
  return request;
}

it("checks broker custody through a direct worker port while its host cannot run callbacks", async () => {
  const owner = service();
  const connection = await owner.connect();
  const slot = new SqliteWorkerSlotCustody();
  const current = activeRequest(slot);
  current.accept();
  try {
    // The synchronous waiter blocks this host; only the service worker can answer.
    assertAdmission(connection, current.descriptor);
    current.cancel();
    assertAdmission(connection, current.descriptor);
    current.retire();
    const successor = activeRequest(slot);
    assertAdmission(connection, successor.descriptor);
    expect(() => assertAdmission(connection, structuredClone(current.descriptor))).toThrow(
      "revoked",
    );
    slot.retire();
    expect(() => assertAdmission(connection, successor.descriptor)).toThrow("revoked");
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
  const custody = activeRequest();
  let now = 0n;
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
  const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => {
    now += 31_000_000_000n;
    return "timed-out";
  });
  try {
    expect(() => assertAdmission({ port: port2, lifetime }, custody.descriptor)).toThrow(
      expect.objectContaining({ code: "admission-timeout" }),
    );
    expect(wait).toHaveBeenCalledOnce();
    const late: unknown = receiveMessageOnPort(port1)?.message;
    if (!isRecord(late) || !(late.decision instanceof Int32Array)) {
      throw new Error("Missing expired admission decision");
    }
    expect(Atomics.compareExchange(late.decision, 0, 0, 1)).toBe(3);
    expect(Atomics.load(late.decision, 0)).toBe(3);
    expect(custody.dispatched).toBe(false);
  } finally {
    port1.close();
    port2.close();
  }
});

it("does not revive a connection after service crash and restart", async () => {
  const workers = vi.spyOn(workerCpu, "createCpuTrackedWorker");
  const owner = service();
  const previous = await owner.connect();
  const custody = activeRequest();
  const worker = workers.mock.results[0];
  if (worker?.type !== "return") {
    throw new Error("Service worker was not created");
  }
  await worker.value.terminate();
  await owner.close();
  const replacement = await service().connect();
  try {
    expect(() => assertAdmission(previous, custody.descriptor)).toThrow("revoked");
    assertAdmission(replacement, custody.descriptor);
    expect(replacement.lifetime.buffer).not.toBe(previous.lifetime.buffer);
  } finally {
    previous.port.close();
    replacement.port.close();
  }
});

it("sees revocation after dispatch and rejects late registration after retirement", async () => {
  const { options, exact, current, mutate } = await fixture();
  const owner = service();
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
  const mutation = mutate();
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
  pause.mockRestore();
  await expect(decision).resolves.toBe("revoked");
  await expect(owner.read(current)).resolves.toBe("pending");
  mutation.settle(true);
  await expect(owner.read(current)).resolves.toBe("current");
  await expect(owner.read(exact)).resolves.toBe("revoked");

  await closeDatabase(options.path);
  openDatabase(options);
  await expect(owner.read(structuredClone(current))).resolves.toBe("revoked");
});

it("settles a crashed service request before starting fresh work without reviving retired authority", async () => {
  const { options, current: request, mutate } = await fixture();
  const failed = service();
  const createWorker = workerCpu.createCpuTrackedWorker;
  const crash = vi
    .spyOn(workerCpu, "createCpuTrackedWorker")
    .mockImplementation((url, workerOptions) => {
      const worker = createWorker(url, workerOptions);
      worker.once("online", () => void worker.terminate());
      return worker;
    });
  await expect(failed.read(request)).rejects.toThrow();
  crash.mockRestore();
  await failed.close();
  const restarted = service();
  const mutation = mutate();
  mutation.settle(false);
  await expect(restarted.read(request)).resolves.toBe("uncertain");
  await closeDatabase(options.path);
  await expect(restarted.read(request)).resolves.toBe("revoked");
});

it("revokes worker-only storage before asynchronous drainage and keeps old descriptors retired", async () => {
  const options = storage("profile-worker-only-");
  const context = captureContext(options);
  const precreation = await captureAuthority(context.admission);
  const previous = boundRequest(precreation);
  const owner = service();
  await expect(owner.read(previous)).resolves.toBe("current");
  new DatabaseSync(options.path).close();
  publishAdmission(context.admission);
  expect(readProfileAuthority(previous.authority)).toBe("revoked");
  await expect(owner.read(previous)).resolves.toBe("revoked");
  const authority = await captureAuthority(context.admission);
  const request = boundRequest(authority);
  await expect(owner.read(request)).resolves.toBe("current");

  const closing = closeDatabase(options.path);
  expect(readProfileAuthority(request.authority)).toBe("revoked");
  await expect(owner.read(request)).resolves.toBe("revoked");
  await closing;
  const reopened = await captureAuthority(captureContext(options).admission);
  await expect(owner.read(boundRequest(reopened))).resolves.toBe("current");
  await expect(owner.read(structuredClone(request))).resolves.toBe("revoked");
});
