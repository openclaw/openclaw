import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  readDiagnosticStabilityBundleFileSync,
  writeDiagnosticStabilityBundleForFailureSync,
} from "../../logging/diagnostic-stability-bundle.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { firstMockArg } from "./adapters/child.test-support.js";
import {
  encodeServiceChildMessage,
  type ServiceChildAnchorPayload,
} from "./service-child-protocol.js";
import {
  createServiceChildRelayAdapter,
  createWritableRelayChild,
} from "./service-child-relay-host.test-support.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.spawn.mockReset();
});

it.each(["lineage", "signal"] as const)(
  "retains cleanup owner diagnostics through bundle readback when %s settlement fails",
  async (failure) => {
    mockProcessPlatform("darwin");
    const groupProbe = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("synthetic missing process group"), { code: "ESRCH" });
    });
    const stub = createWritableRelayChild();
    mocks.spawn.mockReturnValue(stub.child);
    const privateValues = [
      "fixture-command-private",
      "fixture-argument-private",
      "/tmp/fixture-cwd-private",
      "fixture-environment-private",
      "fixture-input-private",
    ];
    const starting = createServiceChildRelayAdapter({
      command: privateValues[0]!,
      args: [privateValues[1]!],
      cwd: privateValues[2],
      env: { FIXTURE_VALUE: privateValues[3] },
      input: privateValues[4],
      stdinMode: "pipe-closed",
      oomScoreWrapperSelected: false,
    });
    const start = firstMockArg(stub.sendMock, "service start");
    if (!isRecord(start) || typeof start.generation !== "string") {
      throw new Error("Expected an admitted service generation");
    }
    const generation = start.generation;
    let sequence = 0;
    const emit = (payload: ServiceChildAnchorPayload) =>
      stub.control.push(
        Buffer.from(encodeServiceChildMessage({ ...payload, generation, sequence: ++sequence })),
      );
    emit({ type: "ready", commandPid: 2345, anchorPid: 3456 });
    const adapter = await starting;
    const outcomes = Promise.allSettled([adapter.wait(), adapter.waitForExtinction()]);
    const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const signalSecret = "sk-1234567890abcdef";
    try {
      emit({ type: "root-result", code: 23, signal: null });
      stub.stdout.end();
      stub.stderr.end();
      await nextTurn();
      await expect(adapter.wait()).resolves.toEqual({ code: 23, signal: null });
      emit({ type: "closing", reason: "cancel" });
      await nextTurn();
      stub.control.destroy();
      if (failure === "lineage") {
        stub.disconnectMock();
        stub.emitExit(0);
      } else {
        stub.lineage.end();
        await nextTurn();
        groupProbe.mockReturnValue(true);
        stub.sendMock.mockImplementation((_message, ...args) => {
          const callback = args.findLast((arg) => typeof arg === "function");
          callback?.(
            Object.assign(new Error(`retirement failed: OPENAI_API_KEY=${signalSecret}`), {
              code: "EIO",
            }),
          );
          return true;
        });
        adapter.kill("SIGKILL");
      }
      await nextTurn();
      now.mockReturnValue(15_000);
      await vi.advanceTimersByTimeAsync(5_000);
      const results = await outcomes;
      expect(results[0]).toMatchObject({ status: "fulfilled", value: { code: 23, signal: null } });
      expect(results[1]).toMatchObject({ status: "rejected" });
      if (results[1].status !== "rejected") {
        throw new Error("Missing extinction rejection");
      }
      const written = writeDiagnosticStabilityBundleForFailureSync(
        "gateway.stop_close_failed",
        results[1].reason,
        {
          stateDir: tempDirs.make("openclaw-cleanup-diagnostics-"),
          shutdownStep: "gateway-server-close",
        },
      );
      if (written.status !== "written") {
        throw new Error("Failed to write fixture bundle");
      }
      const readback = readDiagnosticStabilityBundleFileSync(written.path);
      if (readback.status !== "found") {
        throw new Error("Failed to read fixture bundle");
      }
      const errors = readback.bundle.evidence?.shutdown?.errors;
      expect(errors?.[0]?.message).toContain("hard deadline");
      expect(errors?.[0]?.message).toContain(`"lineageEof":${failure === "lineage"}`);
      expect(errors?.[1]?.message).toBe(
        "service child cleanup owner: " +
          JSON.stringify({
            generation,
            relayPid: 1234,
            anchorPid: 3456,
            commandPid: 2345,
            treeOwnership: "process-group",
            durationMs: failure === "lineage" ? 0 : 5_000,
            ...(failure === "signal" ? { escalationAfterMs: 0 } : {}),
          }),
      );
      expect(errors?.[1]?.message?.length).toBeLessThanOrEqual(500);
      if (failure === "signal") {
        expect(errors?.[2]).toMatchObject({
          code: "EIO",
          message: expect.stringContaining("retirement failed"),
        });
      }
      for (const value of [...privateValues, signalSecret]) {
        expect(fs.readFileSync(written.path, "utf8")).not.toContain(value);
        expect(JSON.stringify(readback.bundle)).not.toContain(value);
      }
      stub.lineage.end();
      stub.emitExit(0);
      await nextTurn();
      expect(await Promise.allSettled([adapter.wait(), adapter.waitForExtinction()])).toEqual(
        results,
      );
    } finally {
      stub.control.destroy();
      stub.lineage.destroy();
      stub.stdout.destroy();
      stub.stderr.destroy();
      stub.child.stdin?.destroy();
      stub.disconnectMock();
      stub.emitExit(0);
    }
  },
);
