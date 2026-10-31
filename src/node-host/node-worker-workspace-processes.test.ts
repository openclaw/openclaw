import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
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
function nodeCommand(script: string, extra: Partial<NodeWorkerWorkspaceExecInput> = {}) {
  return { ...identity, argv: [runtimeExecutableName, "-e", script], ...extra };
}
async function withHeldLookup(
  workspace: NodeWorkerWorkspaceRuntime,
  command: NodeWorkerWorkspaceExecInput,
  effect: (
    pending: ReturnType<NodeWorkerWorkspaceRuntime["exec"]>,
    release: () => void,
  ) => Promise<void>,
) {
  const entered = createDeferredCore();
  const lookup = createDeferredCore<undefined>();
  vi.spyOn(NodeWorkerPreparedWorkspaceStore.prototype, "find").mockImplementationOnce(async () => {
    entered.resolve();
    return await lookup.promise;
  });
  const pending = workspace.exec(command);
  void pending.catch(() => undefined);
  try {
    await awaitGateBeforeSettlement(entered.promise, pending, "lookup did not hold the command");
    await effect(pending, () => lookup.resolve(undefined));
  } finally {
    lookup.resolve(undefined);
    await pending.catch(() => undefined);
  }
}
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
  if (ephemeral) {
    vi.spyOn(NodeWorkerPreparedWorkspaceStore.prototype, "find").mockResolvedValue(undefined);
  }
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
  const stop = (ownerEpoch = 1, cleanup?: () => Promise<void>) =>
    workspace.processes.stopEnvironment({ ...identity, ownerEpoch }, cleanup);
  const launch = async (signal: AbortSignal, caller?: AbortSignal) => ({
    started: await workspace.exec(start, caller),
    url: await ready(signal),
  });
  const rejectRetired = (command: NodeWorkerWorkspaceExecInput) =>
    expect(workspace.exec(command)).rejects.toThrow("retired");
  const collect = (sequence: number) =>
    workspace.applyRetainSnapshot(
      {
        version: 1,
        gatewayNamespace: identity.gatewayNamespace,
        controllerId: "retention",
        sequence,
        retain: [],
      },
      async () => [],
    );
  return { root, workspace, start, control, launch, stop, collect, rejectRetired };
}

it("rejects outside path operands after positional arguments, eval terminators, and option values", async () => {
  const { workspace } = fixture(true);
  const initial = await workspace.exec(
    nodeCommand("process.exit(0)", { nativeProcessOwner: true }),
  );
  const outside = path.join(tempDirs.make("node-workspace-outside-"), "outside.cjs");
  fs.writeFileSync(outside, "process.exit(0)");
  fs.writeFileSync(path.join(initial.workspaceDir, "tool.cjs"), "process.exit(0)");
  const commands = [
    [...(process.versions.bun ? ["run"] : []), "./tool.cjs", "-e", outside],
    ["-e", "process.exit(0)", "--", "-e", outside],
    ["-e", "process.exit(0)", "label", "-p", outside],
    ["--title", "-e", outside],
  ];
  for (const args of commands) {
    await expect(
      workspace.exec({
        ...identity,
        nativeProcessOwner: true,
        argv: [runtimeExecutableName, ...args],
      }),
    ).rejects.toThrow("workspace command argv resolves outside its workspace");
  }
});

it("keeps identical logical process ids isolated across node workspace runtimes", async ({
  signal,
}) => {
  const first = fixture();
  const second = fixture();
  const { url: firstUrl } = await first.launch(signal);
  const { url: secondUrl } = await second.launch(signal);
  await first.stop();
  await expect(fetch(firstUrl)).rejects.toThrow();
  expect(await (await fetch(secondUrl)).text()).toBe(":99");
});

it("rejects an unavailable app while preserving an already running server", async ({ signal }) => {
  const { workspace, start, launch } = fixture();
  const { url } = await launch(signal);
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
  const { workspace, start, control, launch } = fixture();
  const turn = new AbortController();
  const { started, url } = await launch(signal, turn.signal);
  expect(await (await fetch(url)).text()).toBe(":99");
  turn.abort();
  await workspace.exec(
    nodeCommand('require("node:fs").writeFileSync("page.txt", "updated preview")'),
  );
  expect(await (await fetch(url)).text()).toBe("updated preview");
  const retried = await workspace.exec(start);
  expect(retried.process).toEqual({ processId: "preview-server", state: "running" });
  expect(retried.workspaceDir).toBe(started.workspaceDir);
  expect(retried.stdout.trim()).toBe(url);
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
  const { workspace, control, launch, stop, collect } = fixture();
  const { started, url } = await launch(signal);
  await expect(control("stop", { sessionId: "another-conversation" })).rejects.toThrow(
    "unknown workspace process",
  );
  await collect(1);
  expect(fs.existsSync(started.workspaceDir)).toBe(true);
  expect((await fetch(url)).ok).toBe(true);
  await stop();
  await expect(fetch(url)).rejects.toThrow();
  const resumed = await workspace.exec(
    nodeCommand("process.exit(0)", { nativeProcessOwner: true }),
  );
  expect(resumed.code).toBe(0);
  await collect(2);
  expect(fs.existsSync(started.workspaceDir)).toBe(false);
});

it("revokes a queued reset command but reopens fresh execution at the retained epoch", async () => {
  const { workspace, stop } = fixture(true);
  const command = nodeCommand("process.stdout.write('fresh')", {
    nativeProcessOwner: true,
    resetWorkspace: true,
  });
  // Keep a sentinel in the retained workspace so a late reset cannot silently delete it.
  const initial = await workspace.exec(
    nodeCommand("process.exit(0)", { nativeProcessOwner: true }),
  );
  const sentinel = path.join(initial.workspaceDir, "retained.txt");
  fs.writeFileSync(sentinel, "retained");
  await withHeldLookup(workspace, command, async (pending, release) => {
    await stop();
    release();
    await expect(pending).rejects.toThrow("retired");
    expect(fs.readFileSync(sentinel, "utf8")).toBe("retained");
    const fresh = await workspace.exec(command);
    expect(fresh).toMatchObject({ code: 0, stdout: "fresh" });
  });
});

it("keeps overlapping stops sealed and excludes higher epochs from stale stop", async () => {
  const { workspace, stop, rejectRetired } = fixture(true);
  const first = createDeferredCore();
  const secondGate = createEnteredGate();
  const command = nodeCommand("process.stdout.write('fresh')", { nativeProcessOwner: true });
  const stopping = stop(1, () => first.promise);
  const overlapping = stop(1, secondGate.wait);
  try {
    await rejectRetired(command);
    first.resolve();
    await stopping;
    await awaitGateBeforeSettlement(secondGate.entered, overlapping, "second stop did not begin");
    await rejectRetired(command);
    secondGate.release();
    await overlapping;
    expect((await workspace.exec(command)).stdout).toBe("fresh");
    await stop(2);
    await rejectRetired(command);
    await withHeldLookup(workspace, { ...command, generation: 3 }, async (higher, release) => {
      await stop();
      release();
      expect((await higher).stdout).toBe("fresh");
    });
    const lowerGate = createEnteredGate();
    const lower = stop(1, lowerGate.wait);
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      await awaitGateBeforeSettlement(lowerGate.entered, lower, "lower-epoch stop did not begin");
      expect(workspace.processes.hasActiveWork()).toBe(true);
      closing = workspace.processes.close().then(() => {
        closed = true;
      });
      const drained = await workspace.exec({ ...identity, argv: [NODE_WORKSPACE_DRAIN_COMMAND] });
      expect(drained.stdout.trim()).toBe("drained");
      expect(closed).toBe(false);
      lowerGate.release();
      await closing;
      await rejectRetired({ ...command, generation: 3 });
    } finally {
      lowerGate.release();
      await Promise.allSettled([lower, closing]);
    }
  } finally {
    first.resolve();
    secondGate.release();
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
