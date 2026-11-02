import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAgentToolsSandboxContext } from "../../agents/test-helpers/agent-tools-sandbox-context.js";
import { createStubChildAdapter } from "./supervisor.test-support.js";

const { createChildAdapterMock, createPtyAdapterMock, getProcessSupervisorMock } = vi.hoisted(
  () => ({
    createChildAdapterMock: vi.fn(),
    createPtyAdapterMock: vi.fn(),
    getProcessSupervisorMock: vi.fn(),
  }),
);

vi.mock("./adapters/child.js", () => ({
  createChildAdapter: async (
    ...args: Parameters<typeof import("./adapters/child.js").createChildAdapter>
  ) => ({
    adapter: await createChildAdapterMock(...args),
    ready: Promise.resolve(),
  }),
}));

vi.mock("./adapters/pty.js", () => ({ createPtyAdapter: createPtyAdapterMock }));
vi.mock("../../agents/shell-snapshot.js", () => ({
  maybeWrapCommandWithShellSnapshot: async ({ command }: { command: string }) => command,
}));

vi.mock("./index.js", () => ({
  getProcessSupervisor: getProcessSupervisorMock,
}));

let runExecProcess: typeof import("../../agents/bash-tools.exec-runtime.js").runExecProcess;
let createProcessSupervisor: typeof import("./supervisor.js").createProcessSupervisor;
let createOpenClawCodingTools: typeof import("../../agents/agent-tools.js").createOpenClawCodingTools;
let supervisor: ReturnType<typeof createProcessSupervisor>;
let scopeKey: string;
const generationCleanups: Array<(reason: string) => Promise<void>> = [];
let child: ReturnType<typeof createStubChildAdapter>;
let external: typeof child;
let extinction: ReturnType<typeof createDeferred<void>>;
let run: Awaited<ReturnType<typeof runExecProcess>> | undefined;

async function expectPending(promise: Promise<unknown>) {
  const settled = vi.fn();
  void promise.then(settled, settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
}

function prepareOneShotTools() {
  createOpenClawCodingTools({
    config: { plugins: { enabled: false } },
    sessionKey: scopeKey,
    workspaceDir: "/workspace",
    cwd: "/workspace",
    sandbox: createAgentToolsSandboxContext({ workspaceDir: "/workspace" }),
    oneShotCliRun: true,
    registerRunCleanup: (cleanup) => generationCleanups.push(cleanup),
    toolConstructionPlan: {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: false,
      includeOpenClawTools: false,
      includePluginTools: false,
    },
  });
  return async (reason: string) => {
    await Promise.all(generationCleanups.map((cleanup) => cleanup(reason)));
  };
}

describe("one-shot tool-generation process cleanup", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ createProcessSupervisor } = await import("./supervisor.js"));
    ({ createOpenClawCodingTools } = await import("../../agents/agent-tools.js"));
    ({ runExecProcess } = await import("../../agents/bash-tools.exec-runtime.js"));
  });

  beforeEach(() => {
    createChildAdapterMock.mockReset();
    createPtyAdapterMock.mockReset();
    getProcessSupervisorMock.mockReset();
    vi.useRealTimers();
    supervisor = createProcessSupervisor();
    getProcessSupervisorMock.mockReturnValue(supervisor);
    scopeKey = `scope:${expect.getState().currentTestName}`;
    extinction = createDeferred();
    child = Object.assign(createStubChildAdapter(), {
      waitForExtinction: () => extinction.promise,
    });
    external = createStubChildAdapter();
    run = undefined;
    createChildAdapterMock.mockResolvedValue(child);
  });

  afterEach(async () => {
    child.settle(0);
    external.settle(0);
    extinction.resolve();
    await Promise.allSettled([
      run?.promise,
      ...generationCleanups.splice(0).map((cleanup) => cleanup("test cleanup")),
      supervisor.shutdown(),
    ]);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("joins one-shot backend cleanup before reporting host cleanup failure", async () => {
    createChildAdapterMock.mockResolvedValueOnce(external).mockResolvedValueOnce(child);
    const cleanup = prepareOneShotTools();
    const externalRun = await supervisor.spawn({
      mode: "child",
      argv: ["fixture"],
      scopeKey,
      cleanupOwnership: "external",
    });
    const hostRun = await supervisor.spawn({
      mode: "child",
      scopeKey,
      argv: ["fixture"],
    });
    expect(createChildAdapterMock.mock.calls[0]?.[0].ownProcessTree).toBeUndefined();
    expect(createChildAdapterMock.mock.calls[1]?.[0].ownProcessTree).toBe(true);
    external.settle(0);
    child.settle(0);
    await Promise.all([externalRun.wait(), hostRun.wait()]);
    const closing = cleanup("completed");
    await expectPending(closing);
    expect(child.killMock).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    extinction.reject(new Error("owned host cleanup failed"));
    await expect(closing).rejects.toThrow("owned host cleanup failed");
    await expect(supervisor.shutdown()).rejects.toThrow("owned host cleanup failed");
  });

  it("runs a one-shot host PTY request once through the owned child fallback", async () => {
    const pty = createStubChildAdapter();
    pty.settle(0);
    createPtyAdapterMock.mockResolvedValue(pty);
    const warnings: string[] = [];
    const cleanup = prepareOneShotTools();
    run = await runExecProcess({
      command: "fixture-command",
      workdir: "/tmp",
      env: {},
      usePty: true,
      scopeKey,
      warnings,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      notifyOnExit: false,
      timeoutSec: null,
    });
    expect(createPtyAdapterMock).not.toHaveBeenCalled();
    expect(createChildAdapterMock).toHaveBeenCalledOnce();
    expect(createChildAdapterMock.mock.calls[0]?.[0].ownProcessTree).toBe(true);
    expect(warnings).toEqual([
      expect.stringContaining("PTY is unavailable when execution requires process-tree cleanup"),
    ]);
    child.emitStdout("command ran once");
    child.settle(0);
    await vi.waitFor(() => expect(child.killMock).toHaveBeenCalledExactlyOnceWith("SIGTERM"));
    await expectPending(run.promise);
    const closing = cleanup("completed");
    await expectPending(closing);
    expect(child.killMock).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    extinction.resolve();
    await expect(run.promise).resolves.toMatchObject({
      status: "completed",
      aggregated: "command ran once",
    });
    await expect(closing).resolves.toBeUndefined();
  });
});
