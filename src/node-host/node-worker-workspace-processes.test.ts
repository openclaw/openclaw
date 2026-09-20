import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  parseNodeWorkerWorkspaceExecInput,
  parseNodeWorkerWorkspaceExecResult,
  type NodeWorkerWorkspaceExecInput,
} from "../worker/node-workspace-protocol.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workspaces: NodeWorkerWorkspaceRuntime[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.processes.close()));
});

const identity = {
  gatewayNamespace: "gateway-preview",
  environmentId: "worker:preview",
  sessionId: "conversation-preview",
  generation: 1,
};
const serverScript = `
const fs = require("node:fs");
const server = require("node:http").createServer((req, res) => res.end(fs.existsSync("page.txt") ? fs.readFileSync("page.txt") : process.env.DISPLAY));
server.listen(0, "127.0.0.1", () => console.log("http://127.0.0.1:" + server.address().port));
`;
const runtimeExecutableName = path.basename(process.execPath);
function fixture() {
  const root = tempDirs.make("node-workspace-preview-");
  const workspace = new NodeWorkerWorkspaceRuntime({
    root,
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
    argv: [runtimeExecutableName, "-e", serverScript],
    process: { action: "start", processId: "preview-server" },
  };
  const control = (action: "status" | "stop", extra: Partial<typeof identity> = {}) =>
    workspace.exec({
      ...identity,
      ...extra,
      argv: ["openclaw-internal-workspace-process"],
      process: { action, processId: "preview-server" },
    });
  const ready = async () => {
    let url = "";
    await vi.waitFor(async () => {
      url = (await control("status")).stdout.trim();
      expect(url).toMatch(/^http:\/\/127.0.0.1:\d+$/);
    });
    return url;
  };
  return { workspace, start, control, ready };
}

describe("conversation-owned preview processes", () => {
  it("keeps identical logical process ids isolated across node workspace runtimes", async () => {
    const first = fixture();
    const second = fixture();
    await first.workspace.exec(first.start);
    await second.workspace.exec(second.start);
    const [firstUrl, secondUrl] = await Promise.all([first.ready(), second.ready()]);
    await first.workspace.processes.stopEnvironment({ ...identity, ownerEpoch: 1 });
    await expect(fetch(firstUrl)).rejects.toThrow();
    expect(await (await fetch(secondUrl)).text()).toBe(":99");
  });

  it("rejects an unavailable app while preserving an already running server", async () => {
    const { workspace, start, ready } = fixture();
    await workspace.exec(start);
    const url = await ready();
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

  it("keeps the same app and desktop environment across turns, reuses a retried start, and stops its server", async () => {
    const { workspace, start, control, ready } = fixture();
    const turn = new AbortController();
    const started = await workspace.exec(start, turn.signal);
    const url = await ready();
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

  it("keeps running workspaces through retention and fences exact environment cleanup", async () => {
    const { workspace, start, control, ready } = fixture();
    const launched = await workspace.exec(start);
    const url = await ready();
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
      () => [],
    );
    expect(fs.existsSync(launched.workspaceDir)).toBe(true);
    expect((await fetch(url)).ok).toBe(true);
    await workspace.processes.stopEnvironment({ ...identity, ownerEpoch: 1 });
    await expect(fetch(url)).rejects.toThrow();
    await expect(workspace.exec(start)).rejects.toThrow("retired");
    await workspace.applyRetainSnapshot(
      {
        version: 1,
        gatewayNamespace: identity.gatewayNamespace,
        controllerId: "retention",
        sequence: 2,
        retain: [],
      },
      () => [],
    );
    expect(fs.existsSync(launched.workspaceDir)).toBe(false);
  });

  it("rejects revoked starts before launch and bounds both output streams", async () => {
    const { workspace, start, control } = fixture();
    const revoked = AbortSignal.abort();
    await expect(workspace.exec(start, revoked)).rejects.toThrow();
    await expect(control("status")).rejects.toThrow("unknown workspace process");
    await workspace.exec({
      ...start,
      argv: [
        runtimeExecutableName,
        "-e",
        'process.stdout.write("界".repeat(20000)); process.stderr.write("界".repeat(20000))',
      ],
    });
    await vi.waitFor(async () => {
      const result = await control("status");
      expect(result.process?.state).toBe("exited");
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(parseNodeWorkerWorkspaceExecResult(result)).toEqual(result);
    });
  });

  it.each([
    { process: { action: "start", processId: "bad/id" } },
    { process: { action: "status", processId: "preview" } },
    { process: { action: "start", processId: "preview" }, resetWorkspace: true },
  ])("rejects malformed process operations at the node protocol boundary %#", (change) => {
    expect(() =>
      parseNodeWorkerWorkspaceExecInput(
        JSON.stringify({ ...identity, argv: ["node", "-e", "process.exit(0)"], ...change }),
      ),
    ).toThrow("INVALID_REQUEST:");
  });
});
