import { once } from "node:events";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  createChildEnv,
  parseNodeMcpTextRecord,
  processIsAlive,
  startHttpFixture,
  stopChild,
  waitForMcpFixtureGate,
} from "./gateway-node-mcp.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Tree signaling joins dispatch, not the foreign descendant's waitpid completion.
async function waitForDescendantExit(pid: number, signal: AbortSignal): Promise<void> {
  try {
    while (processIsAlive(pid)) {
      await waitForProcessTick(10, undefined, { signal });
    }
  } catch (error) {
    throw new Error(`timed out waiting for fixture descendant ${pid} to exit`, { cause: error });
  }
}

describe("gateway node MCP fixture ownership", () => {
  it.for(["existing", "published"] as const)(
    "joins its watcher when the gate is %s",
    async (mode, { signal }) => {
      const root = tempDirs.make("mcp-gate-publication-");
      const gate = path.join(root, "gate");
      if (mode === "existing") {
        await fs.writeFile(gate, "ready");
      }
      const watching = createDeferred<nodeFs.FSWatcher>();
      const watch = nodeFs.watch;
      const observeWatch = vi.fn((...args: Parameters<typeof watch>) => {
        const watcher = watch(...args);
        watching.resolve(watcher);
        return watcher;
      });
      vi.resetModules();
      vi.doMock("node:fs", () => ({ ...nodeFs, watch: observeWatch }));
      const { waitForMcpFixtureGate: waitForGate } =
        await import("./gateway-node-mcp.test-support.js");
      let watcher: nodeFs.FSWatcher | undefined;
      const waiting = waitForGate(gate, signal);
      try {
        if (mode === "published") {
          watcher = await withinTest(watching.promise, signal);
          const closed = once(watcher, "close");
          await fs.writeFile(gate, "ready");
          await waiting;
          await closed;
        } else {
          await waiting;
          expect(observeWatch).not.toHaveBeenCalled();
        }
        expect(await fs.readFile(gate, "utf8")).toBe("ready");
      } finally {
        watcher?.close();
        await waiting.catch(() => {});
        vi.doUnmock("node:fs");
        vi.resetModules();
      }
    },
  );

  it("releases its deadline when the real gate watcher cannot be constructed", async ({
    signal,
  }) => {
    const root = tempDirs.make("mcp-gate-watch-failure-");
    const timers = vi.spyOn(globalThis, "setTimeout");
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    try {
      await expect(
        waitForMcpFixtureGate(path.join(root, "missing", "gate"), signal),
      ).rejects.toMatchObject({
        code: "ENOENT",
        syscall: "watch",
      });
      const allocated = timers.mock.results.flatMap((result, index) =>
        result.type === "return" && timers.mock.calls[index]?.[1] === 30_000 ? [result.value] : [],
      );
      expect(
        allocated.filter((timer) => !cleared.mock.calls.some(([value]) => value === timer)).length,
      ).toBe(0);
    } finally {
      for (const result of timers.mock.results) {
        if (result.type === "return") {
          clearTimeout(result.value);
        }
      }
      timers.mockRestore();
      cleared.mockRestore();
    }
  });

  it.each([
    ["direct", (payload: object) => payload],
    ["node.invoke", (payload: object) => ({ ok: true, payload })],
  ])("parses %s MCP text records", (_label, wrap) => {
    const fact = { label: "node-stdio", marker: "ready", pid: 42 };
    expect(
      parseNodeMcpTextRecord(wrap({ content: [{ type: "text", text: JSON.stringify(fact) }] })),
    ).toEqual(fact);
  });

  it("kills a spawned fixture when readiness validation fails", async ({
    signal,
    onTestFinished,
  }) => {
    const fixtureDirs = useAutoCleanupTempDirTracker(onTestFinished);
    const root = fixtureDirs.make("mcp-fixture-startup-failure-");
    const fixturePath = path.join(root, "invalid-fixture.mjs");
    const pidPath = path.join(root, "fixture.pid");
    await fs.writeFile(
      fixturePath,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); console.log(JSON.stringify({type:"wrong"})); setInterval(() => {}, 1000);`,
      "utf8",
    );

    let pid: number | undefined;
    const startingFixture = startHttpFixture({
      fixturePath,
      signal,
      labelPrefix: "node",
      env: createChildEnv({ home: root, tempDir: os.tmpdir() }),
    });
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        await stopChild(await startingFixture.catch(() => undefined));
        if (pid !== undefined && processIsAlive(pid)) {
          process.kill(pid, "SIGKILL");
        }
      })());
    onTestFinished(cleanup);
    try {
      await expect(startingFixture).rejects.toThrow("invalid readiness");
      const fixturePid = Number(await fs.readFile(pidPath, "utf8"));
      pid = fixturePid;
      expect(processIsAlive(fixturePid)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("kills task-owned fixture descendants when stopping the captured root", async ({
    signal,
    onTestFinished,
  }) => {
    const fixtureDirs = useAutoCleanupTempDirTracker(onTestFinished);
    const root = fixtureDirs.make("mcp-fixture-descendant-cleanup-");
    const fixturePath = path.join(root, "fixture.mjs");
    const descendantPidPath = path.join(root, "descendant.pid");
    await fs.writeFile(
      fixturePath,
      `import {spawn} from "node:child_process"; import fs from "node:fs"; const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid)); console.log(JSON.stringify({type:"openclaw-mcp-parity-ready",urls:{streamableHttp:"http://127.0.0.1/mcp",sse:"http://127.0.0.1/sse"}})); setInterval(()=>{},1000);`,
      "utf8",
    );

    const startingFixture = startHttpFixture({
      fixturePath,
      signal,
      labelPrefix: "node",
      env: createChildEnv({ home: root, tempDir: os.tmpdir() }),
    });
    let descendantPid: number | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        const fixture = await startingFixture.catch(() => undefined);
        if (!fixture) {
          return;
        }
        // The fixture records its descendant before publishing readiness.
        descendantPid ??= Number(await fs.readFile(descendantPidPath, "utf8"));
        await stopChild(fixture);
        if (processIsAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      })());
    onTestFinished(cleanup);
    try {
      const fixture = await startingFixture;
      const childPid = Number(await fs.readFile(descendantPidPath, "utf8"));
      descendantPid = childPid;
      expect(processIsAlive(childPid)).toBe(true);

      await stopChild(fixture);

      await waitForDescendantExit(childPid, signal);
    } finally {
      await cleanup();
    }
  });
});
