import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
