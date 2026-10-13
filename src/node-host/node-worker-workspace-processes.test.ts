import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  NODE_WORKSPACE_DRAIN_COMMAND,
  parseNodeWorkerWorkspaceExecResult,
  type NodeWorkerWorkspaceExecInput,
} from "../worker/node-workspace-protocol.js";
import { NodeWorkerPreparedWorkspaceStore } from "./node-worker-prepared-workspace-store.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workspaces: NodeWorkerWorkspaceRuntime[] = [];
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.processes.close()));
});

const identity = {
  gatewayNamespace: "gateway-preview",
  environmentId: "worker:preview",
  sessionId: "conversation-preview",
  generation: 1,
};
const serverScript = `
import fs from "node:fs";
import http from "node:http";
const server = http.createServer((req, res) => res.end(fs.existsSync("page.txt") ? fs.readFileSync("page.txt") : process.env.DISPLAY));
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("http://127.0.0.1:" + server.address().port + "\\n", () => sendReceipt(source, "ready"));
});
`;
const runtimeExecutableName = path.basename(process.execPath);
function fixture(ephemeral = false) {
  const root = tempDirs.make("node-workspace-preview-");
  const workspace = new NodeWorkerWorkspaceRuntime({
    root,
    ephemeral,
    env: {
      PATH: path.dirname(process.execPath),
      HOME: root,
      DISPLAY: ":99",
      NODE_DISABLE_COMPILE_CACHE: "1",
    },
  });
  workspaces.push(workspace);
  const start: NodeWorkerWorkspaceExecInput = {
    ...identity,
    argv: [
      runtimeExecutableName,
      "--input-type=module",
      "-e",
      `${fixtureReceiptClientSource(receipts.endpoint)}\nconst source = ${JSON.stringify(root)};\n${serverScript}`,
    ],
    process: { action: "start", processId: "preview-server" },
  };
  const control = (action: "status" | "stop", extra: Partial<typeof identity> = {}) =>
    workspace.exec({
      ...identity,
      ...extra,
      argv: ["openclaw-internal-workspace-process"],
      process: { action, processId: "preview-server" },
    });
  const ready = async (signal: AbortSignal) => {
    await withinTest(receipts.waitFor(root, "ready"), signal);
    let url = "";
    await vi.waitFor(async () => {
      url = (await control("status")).stdout.trim();
      expect(url).toMatch(/^http:\/\/127.0.0.1:\d+$/);
    });
    return url;
  };
  return { root, workspace, start, control, ready };
}

describe("conversation-owned preview processes", () => {
  it("keeps identical logical process ids isolated across node workspace runtimes", async ({
    signal,
  }) => {
    const first = fixture();
    const second = fixture();
    await first.workspace.exec(first.start);
    await second.workspace.exec(second.start);
    const [firstUrl, secondUrl] = await Promise.all([first.ready(signal), second.ready(signal)]);
    await first.workspace.processes.stopEnvironment({ ...identity, ownerEpoch: 1 });
    await expect(fetch(firstUrl)).rejects.toThrow();
    expect(await (await fetch(secondUrl)).text()).toBe(":99");
  });

  it("rejects an unavailable app while preserving an already running server", async ({
    signal,
  }) => {
    const { workspace, start, ready } = fixture();
    await workspace.exec(start);
    const url = await ready(signal);
    await expect(
      workspace.exec({
        ...start,
        process: { action: "start", processId: "missing-app" },
        argv: ["openclaw-nonexistent-preview-command"],
      }),
    ).rejects.toThrow("executable is unavailable");
    expect(workspace.processes.hasActiveWork()).toBe(true);
    expect((await fetch(url)).ok).toBe(true);
    await workspace.exec({
      ...start,
      process: { action: "start", processId: "missing-app" },
      argv: [runtimeExecutableName, "-e", "process.exit(0)"],
    });
  });

  it("keeps the same app and desktop environment across turns, reuses a retried start, and stops its server", async ({
    signal,
  }) => {
    const { workspace, start, control, ready } = fixture();
    const turn = new AbortController();
    const started = await workspace.exec(start, turn.signal);
    const url = await ready(signal);
    expect(await (await fetch(url)).text()).toBe(":99");
    turn.abort();
    await workspace.exec({
      ...identity,
      argv: [
        runtimeExecutableName,
        "-e",
        'require("node:fs").writeFileSync("page.txt", "updated preview")',
      ],
    });
    expect(await (await fetch(url)).text()).toBe("updated preview");
    const retried = await workspace.exec(start);
    expect(retried.process).toEqual({ processId: "preview-server", state: "running" });
    expect(retried.stdout.trim()).toBe(url);
    expect(retried.workspaceDir).toBe(started.workspaceDir);
    await expect(
      workspace.exec({
        ...start,
        argv: [runtimeExecutableName, "-e", "setInterval(() => {}, 1000)"],
      }),
    ).rejects.toThrow("different command");
    const stopped = await control("stop");
    expect(stopped.process?.state).toBe("exited");
    expect(parseNodeWorkerWorkspaceExecResult(stopped)).toEqual(stopped);
    await expect(fetch(url)).rejects.toThrow();
  });

  it("keeps running workspaces through retention and fences exact environment cleanup", async ({
    signal,
  }) => {
    const { workspace, start, control, ready } = fixture();
    const launched = await workspace.exec(start);
    const url = await ready(signal);
    await expect(control("stop", { sessionId: "another-conversation" })).rejects.toThrow(
      "unknown workspace process",
    );
    await workspace.applyRetainSnapshot(
      {
        version: 1,
        gatewayNamespace: identity.gatewayNamespace,
        controllerId: "retention",
        sequence: 1,
        retain: [],
      },
      async () => [],
    );
    expect(fs.existsSync(launched.workspaceDir)).toBe(true);
    expect((await fetch(url)).ok).toBe(true);
    await workspace.processes.stopEnvironment({ ...identity, ownerEpoch: 1 });
    await expect(fetch(url)).rejects.toThrow();
    const resumed = await workspace.exec({
      ...identity,
      nativeProcessOwner: true,
      argv: [runtimeExecutableName, "-e", "process.exit(0)"],
    });
    expect(resumed.code).toBe(0);
    await workspace.applyRetainSnapshot(
      {
        version: 1,
        gatewayNamespace: identity.gatewayNamespace,
        controllerId: "retention",
        sequence: 2,
        retain: [],
      },
      async () => [],
    );
    expect(fs.existsSync(launched.workspaceDir)).toBe(false);
  });

  it("revokes a queued reset command but reopens fresh execution at the retained epoch", async () => {
    const { workspace } = fixture(true);
    const entered = createDeferredCore();
    const lookup = createDeferredCore<undefined>();
    const find = vi
      .spyOn(NodeWorkerPreparedWorkspaceStore.prototype, "find")
      .mockResolvedValue(undefined);
    const command: NodeWorkerWorkspaceExecInput = {
      ...identity,
      argv: [runtimeExecutableName, "-e", "process.stdout.write('fresh')"],
      nativeProcessOwner: true,
      resetWorkspace: true,
    };
    // Keep a sentinel in the retained workspace so a late reset cannot silently delete it.
    const initial = await workspace.exec({
      ...identity,
      nativeProcessOwner: true,
      argv: [runtimeExecutableName, "-e", "process.exit(0)"],
    });
    const sentinel = path.join(initial.workspaceDir, "retained.txt");
    fs.writeFileSync(sentinel, "retained");
    find.mockImplementationOnce(async () => {
      entered.resolve();
      return await lookup.promise;
    });
    const pending = workspace.exec(command);
    void pending.catch(() => undefined);
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "lookup did not hold the command");
      await workspace.processes.stopEnvironment({ ...identity, ownerEpoch: 1 });
      lookup.resolve(undefined);
      await expect(pending).rejects.toThrow("retired");
      expect(fs.readFileSync(sentinel, "utf8")).toBe("retained");
      const fresh = await workspace.exec(command);
      expect(fresh).toMatchObject({ code: 0, stdout: "fresh" });
    } finally {
      lookup.resolve(undefined);
      await pending.catch(() => undefined);
    }
  });

  it("keeps overlapping stops sealed and excludes higher epochs from stale stop", async () => {
    const { workspace } = fixture(true);
    vi.spyOn(NodeWorkerPreparedWorkspaceStore.prototype, "find").mockResolvedValue(undefined);
    const first = createDeferredCore();
    const second = createDeferredCore();
    const secondStarted = createDeferredCore();
    const command: NodeWorkerWorkspaceExecInput = {
      ...identity,
      nativeProcessOwner: true,
      argv: [runtimeExecutableName, "-e", "process.stdout.write('fresh')"],
    };
    const stopping = workspace.processes.stopEnvironment(
      { ...identity, ownerEpoch: 1 },
      () => first.promise,
    );
    const overlapping = workspace.processes.stopEnvironment(
      { ...identity, ownerEpoch: 1 },
      async () => {
        secondStarted.resolve();
        await second.promise;
      },
    );
    try {
      await expect(workspace.exec(command)).rejects.toThrow("retired");
      first.resolve();
      await stopping;
      await awaitGateBeforeSettlement(
        secondStarted.promise,
        overlapping,
        "second stop did not begin",
      );
      await expect(workspace.exec(command)).rejects.toThrow("retired");
      second.resolve();
      await overlapping;
      expect((await workspace.exec(command)).stdout).toBe("fresh");
      await workspace.processes.stopEnvironment({ ...identity, ownerEpoch: 2 });
      await expect(workspace.exec(command)).rejects.toThrow("retired");
      const lookup = createDeferredCore<undefined>();
      const entered = createDeferredCore();
      vi.spyOn(NodeWorkerPreparedWorkspaceStore.prototype, "find").mockImplementationOnce(
        async () => {
          entered.resolve();
          return await lookup.promise;
        },
      );
      const higher = workspace.exec({ ...command, generation: 3 });
      void higher.catch(() => undefined);
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          higher,
          "higher-epoch lookup did not begin",
        );
        await workspace.processes.stopEnvironment({ ...identity, ownerEpoch: 1 });
        lookup.resolve(undefined);
        expect((await higher).stdout).toBe("fresh");
      } finally {
        lookup.resolve(undefined);
        await higher.catch(() => undefined);
      }
      const lowerStarted = createDeferredCore();
      const finishLower = createDeferredCore();
      const lower = workspace.processes.stopEnvironment(
        { ...identity, ownerEpoch: 1 },
        async () => {
          lowerStarted.resolve();
          await finishLower.promise;
        },
      );
      let closed = false;
      let closing: Promise<void> | undefined;
      try {
        await awaitGateBeforeSettlement(
          lowerStarted.promise,
          lower,
          "lower-epoch stop did not begin",
        );
        expect(workspace.processes.hasActiveWork()).toBe(true);
        closing = workspace.processes.close().then(() => {
          closed = true;
        });
        const drained = await workspace.exec({ ...identity, argv: [NODE_WORKSPACE_DRAIN_COMMAND] });
        expect(drained.stdout.trim()).toBe("drained");
        expect(closed).toBe(false);
        finishLower.resolve();
        await closing;
        await expect(workspace.exec({ ...command, generation: 3 })).rejects.toThrow("retired");
      } finally {
        finishLower.resolve();
        await Promise.allSettled([lower, closing]);
      }
    } finally {
      first.resolve();
      second.resolve();
      await Promise.allSettled([stopping, overlapping]);
    }
  });

  it("rejects revoked starts before launch and bounds both output streams", async ({ signal }) => {
    const { root, workspace, start, control } = fixture();
    const revoked = AbortSignal.abort();
    await expect(workspace.exec(start, revoked)).rejects.toThrow();
    await expect(control("status")).rejects.toThrow("unknown workspace process");
    await workspace.exec({
      ...start,
      argv: [
        runtimeExecutableName,
        "--input-type=module",
        "-e",
        `${fixtureReceiptClientSource(receipts.endpoint)}
sendReceipt(${JSON.stringify(root)}, "output-ready");
await awaitRelease(${JSON.stringify(root)}, "write");
process.stdout.write("界".repeat(20000)); process.stderr.write("界".repeat(20000));`,
      ],
    });
    await withinTest(receipts.waitFor(root, "output-ready"), signal);
    receipts.release(root, "write");
    await withinTest(receipts.waitForExit(root), signal);
    await vi.waitFor(async () => {
      const result = await control("status");
      expect(result.process?.state).toBe("exited");
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(parseNodeWorkerWorkspaceExecResult(result)).toEqual(result);
    });
  });
});
