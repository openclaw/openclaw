import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { firstMockArg } from "./adapters/child.test-support.js";
import {
  encodeServiceChildMessage,
  type ServiceChildAnchorPayload,
} from "./service-child-protocol.js";
import { createServiceChildRelayAdapter as startServiceChildRelayAdapter } from "./service-child-relay-host.js";
import { createWritableRelayChild } from "./service-child-relay-host.test-support.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

let platformMock: ReturnType<typeof mockProcessPlatform> | undefined;
const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
afterEach(async () => {
  await nextTurn();
  platformMock?.mockRestore();
  platformMock = undefined;
  mocks.spawn.mockReset();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "joins accepted stdout after identity loss while preserving an observed root (root observed=%s)",
  async (rootObserved) => {
    platformMock = mockProcessPlatform("linux");
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("synthetic missing process group"), { code: "ESRCH" });
    });
    const stub = createWritableRelayChild();
    mocks.spawn.mockReturnValue(stub.child);
    const starting = startServiceChildRelayAdapter({
      command: "synthetic-command",
      args: [],
      stdinMode: "pipe-closed",
      oomScoreWrapperSelected: false,
      stdoutConsumption: "awaited",
      ownedWorker: true,
      env: {},
      cleanupBinding: {
        databasePath: "/synthetic/state.sqlite",
        externallySupervised: false,
        launchId: "synthetic-worker",
        planHash: "a".repeat(64),
        supervisor: { pid: 101, startTime: 1 },
      },
    });
    const start = firstMockArg(stub.sendMock, "service start");
    if (!isRecord(start) || typeof start.generation !== "string") {
      throw new Error("Expected an admitted service generation");
    }
    const generation = start.generation;
    let sequence = 0;
    const emit = (payload: ServiceChildAnchorPayload) => {
      stub.control.push(
        Buffer.from(encodeServiceChildMessage({ ...payload, generation, sequence: ++sequence })),
      );
    };
    emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
    const { adapter, ready } = await starting;
    await ready;
    const entered = createDeferred();
    const release = createDeferred();
    const chunks: string[] = [];
    const consumed = adapter.consumeStdout(async (chunk) => {
      chunks.push(chunk);
      if (chunks.length === 1) {
        entered.resolve();
        await release.promise;
      }
    });
    const settled = vi.fn();
    const outcome = adapter.wait();
    void outcome.then(settled, settled);
    const results = Promise.allSettled([outcome, consumed]);
    try {
      stub.stdout.write("accepted");
      await entered.promise;
      if (rootObserved) {
        emit({ type: "root-result", code: 23, signal: null });
        await nextTurn();
      }
      stub.control.destroy();
      await expect(adapter.waitForExtinction()).rejects.toThrow("cleanup identity lost");
      expect(adapter.confirmExtinction()).toBe(false);
      stub.stdout.write(" late tail");
      await nextTurn();
      expect(chunks).toEqual(["accepted"]);
      expect(settled).not.toHaveBeenCalled();
      release.resolve();
      if (rootObserved) {
        await nextTurn();
        expect(settled).not.toHaveBeenCalled();
        stub.stdout.end(" final tail");
        stub.stderr.end();
        expect(await results).toEqual([
          { status: "fulfilled", value: { code: 23, signal: null } },
          { status: "fulfilled", value: undefined },
        ]);
        expect(chunks.join("")).toBe("accepted late tail final tail");
      } else {
        expect(
          await withTestTimeout(results, 1_000, "identity loss still waits for unowned stdout EOF"),
        ).toMatchObject([
          {
            status: "rejected",
            reason: {
              errors: expect.arrayContaining([
                expect.objectContaining({
                  message: expect.stringContaining("cleanup identity lost"),
                }),
              ]),
            },
          },
          { status: "rejected" },
        ]);
        expect(chunks).toEqual(["accepted"]);
        expect(stub.stdout.destroyed).toBe(false);
        expect(stub.stdout.readableEnded).toBe(false);
        stub.stderr.end();
      }
      stub.lineage.end();
      stub.disconnectMock();
      stub.emitExit(0);
      await nextTurn();
      if (!rootObserved) {
        expect(adapter.confirmExtinction()).toBe(false);
        stub.stdout.end(" discarded tail");
        await nextTurn();
        expect(chunks).toEqual(["accepted"]);
      }
      expect(adapter.confirmExtinction()).toBe(true);
    } finally {
      release.resolve();
      stub.stdout.end();
      stub.stderr.end();
      stub.control.destroy();
      stub.lineage.end();
      stub.disconnectMock();
      stub.emitExit(0);
      await results;
      adapter.dispose();
    }
  },
);
