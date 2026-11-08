import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import * as secretInput from "../spawn-secret-input.js";
import { firstMockArg } from "./adapters/child.test-support.js";
import * as serviceChildCleanup from "./service-child-cleanup.js";
import { encodeServiceChildMessage } from "./service-child-protocol.js";
import { createServiceChildRelayAdapter } from "./service-child-relay-host.js";
import { createWritableRelayChild } from "./service-child-relay-host.test-support.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

afterEach(() => {
  mocks.spawn.mockReset();
  vi.restoreAllMocks();
});

it("joins failed POSIX startup cleanup before returning the original executable error", async () => {
  mockProcessPlatform("darwin");
  const stub = createWritableRelayChild();
  mocks.spawn.mockReturnValue(stub.child);
  const groupProbe = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("process group is gone"), { code: "ESRCH" });
  });
  const { adapter, ready } = await createServiceChildRelayAdapter({
    command: "/synthetic-missing-command",
    args: [],
    stdinMode: "pipe-closed",
    oomScoreWrapperSelected: false,
  });
  let settled = false;
  const result = ready.catch((error: unknown) => {
    settled = true;
    return error;
  });
  const start = firstMockArg(stub.sendMock, "service start");
  if (!isRecord(start) || typeof start.generation !== "string") {
    throw new Error("Expected the admitted service generation");
  }
  const generation = start.generation;
  try {
    stub.control.push(
      encodeServiceChildMessage({
        type: "startup-error",
        generation,
        sequence: 1,
        anchorPid: 1235,
        error: "spawn /synthetic-missing-command ENOENT",
        errorDetails: { message: "spawn /synthetic-missing-command ENOENT", code: "ENOENT" },
      }),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
    expect(stub.killMock).not.toHaveBeenCalled();

    stub.control.push(
      encodeServiceChildMessage({
        type: "closing",
        reason: "lineage-lost",
        generation,
        sequence: 2,
      }),
    );
    stub.control.push(null);
    stub.stdout.end();
    stub.stderr.end();
    stub.lineage.end();
    stub.disconnectMock();
    stub.emitExit(0);

    expect(await result).toMatchObject({
      message: "spawn /synthetic-missing-command ENOENT",
      code: "ENOENT",
    });
    await expect(adapter.waitForExtinction()).resolves.toBeUndefined();
    expect(groupProbe).toHaveBeenCalledWith(-1235, 0);
  } finally {
    stub.control.destroy();
    stub.lineage.destroy();
    stub.disconnectMock();
    stub.emitExit(0);
    await result;
    await adapter.waitForExtinction().catch(() => undefined);
    adapter.dispose();
  }
});

it("rejects undefined secret delivery failures at the relay readiness boundary", async () => {
  mockProcessPlatform("darwin");
  const stub = createWritableRelayChild();
  mocks.spawn.mockReturnValue(stub.child);
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("process group is gone"), { code: "ESRCH" });
  });
  vi.spyOn(secretInput, "prepareSecretInputStdio").mockReturnValue({
    deliverTo: vi.fn().mockRejectedValue(undefined),
    [Symbol.dispose]() {},
  });
  const { adapter, ready } = await createServiceChildRelayAdapter({
    command: "synthetic-command",
    args: [],
    stdinMode: "pipe-closed",
    oomScoreWrapperSelected: false,
  });
  const outcome = Promise.allSettled([ready]);
  const start = firstMockArg(stub.sendMock, "service start");
  if (!isRecord(start) || typeof start.generation !== "string") {
    throw new Error("Expected the admitted service generation");
  }
  stub.control.push(
    encodeServiceChildMessage({
      type: "ready",
      generation: start.generation,
      sequence: 1,
      commandPid: 1234,
      anchorPid: 1235,
    }),
  );
  try {
    expect(await outcome).toEqual([{ status: "rejected", reason: undefined }]);
  } finally {
    stub.control.push(
      encodeServiceChildMessage({
        type: "closing",
        generation: start.generation,
        sequence: 2,
        reason: "lineage-lost",
      }),
    );
    stub.control.push(null);
    stub.stdout.end();
    stub.stderr.end();
    stub.lineage.end();
    stub.disconnectMock();
    stub.emitExit(0);
    await adapter.waitForExtinction().catch(() => undefined);
    adapter.dispose();
  }
});

it("preserves an undefined startup rejection from failed authority cleanup", async () => {
  mockProcessPlatform("darwin");
  const stub = createWritableRelayChild();
  mocks.spawn.mockReturnValue(stub.child);
  vi.spyOn(process, "kill").mockReturnValue(true);
  // The lifecycle owner may reject finalization with any JavaScript value.
  const createCleanup = serviceChildCleanup.createServiceChildCleanup;
  vi.spyOn(serviceChildCleanup, "createServiceChildCleanup").mockImplementation(() => {
    const cleanup = createCleanup();
    const close = vi.fn<() => Promise<void>>().mockRejectedValue(undefined);
    return {
      ...cleanup,
      bindAuthorityClose: (_close, onFailure) => cleanup.bindAuthorityClose(close, onFailure),
    };
  });
  const { adapter, ready } = await createServiceChildRelayAdapter({
    command: "synthetic-command",
    args: [],
    stdinMode: "pipe-closed",
    oomScoreWrapperSelected: false,
  });
  const outcome = Promise.allSettled([ready]);
  const start = firstMockArg(stub.sendMock, "service start");
  if (!isRecord(start) || typeof start.generation !== "string") {
    throw new Error("Expected the admitted service generation");
  }
  try {
    // Close before ready: authority finalization owns the startup rejection.
    stub.control.push(
      encodeServiceChildMessage({
        type: "closing",
        generation: start.generation,
        sequence: 1,
        reason: "lineage-lost",
      }),
    );
    stub.lineage.end();
    stub.stdout.end();
    stub.stderr.end();
    stub.disconnectMock();
    stub.emitExit(0);
    stub.control.push(null);
    expect(await outcome).toEqual([{ status: "rejected", reason: undefined }]);
    await expect(adapter.waitForExtinction()).rejects.toBeUndefined();
  } finally {
    stub.control.destroy();
    stub.lineage.destroy();
    stub.disconnectMock();
    stub.emitExit(0);
    await outcome;
    await adapter.waitForExtinction().catch(() => undefined);
    adapter.dispose();
  }
});
