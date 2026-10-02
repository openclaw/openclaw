import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { requireNodeTool } from "../../test/helpers/node-toolchain.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { isChildProcessTreeAlive } from "./child-process-tree.js";
import {
  settleCommandProcessGroups,
  type CommandProcessIdentity,
} from "./command-process-custody.js";
import { runUtf8CommandWithTimeout } from "./exec-runner.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts?.close();
});

it.skipIf(process.platform === "win32")(
  "retains and stops a detached writer after its busy scope owner is killed",
  async ({ signal }) => {
    const root = directories.make("command-custody-");
    const receipt = path.join(root, "custody.json");
    const effect = path.join(root, "effect");
    const node = requireNodeTool("node");
    const moduleUrl = (name: string, sourceWorkerName = name) =>
      resolveRuntimeWorkerUrl({
        currentModuleUrl: import.meta.url,
        sourceWorkerName,
        distWorkerPath: name === "pid-alive" ? "shared/pid-alive.js" : `process/${name}.js`,
      });
    const spawnOwner = moduleUrl("exec-spawn");
    const identityOwner = moduleUrl("pid-alive", "../shared/pid-alive");
    const leaf = `
      import fs from 'node:fs';
      import { MessageChannel } from 'node:worker_threads';
      ${fixtureReceiptClientSource(receipts.endpoint)}
      globalThis.keepalive = new MessageChannel();
      keepalive.port1.on('message', () => {});
      process.on('SIGUSR2', () => {
        fs.writeFileSync(${JSON.stringify(effect)}, 'still writable');
        sendReceipt(${JSON.stringify(effect)}, 'written');
      });
      process.stdout.write('ready\\n');
    `;
    const script = `
      import fs from 'node:fs';
      import { once } from 'node:events';
      import { withCommandProcessScope, spawnCommand } from ${JSON.stringify(spawnOwner.href)};
      import { getProcessInstanceStartTime } from ${JSON.stringify(identityOwner.href)};
      const record = value => fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(value));
      process.on('SIGTERM', () => {});
      await withCommandProcessScope(async () => {
        const child = spawnCommand([${JSON.stringify(node)}, '--input-type=module', '-e', ${JSON.stringify(leaf)}], {
          stdio: ['ignore', 'pipe', 'ignore'], buffer: false, reject: false,
        });
        await once(child.stdout, 'data');
        process.stdout.write(JSON.stringify({ root: process.pid,
          identity: { pid: child.pid, startedAt: getProcessInstanceStartTime(child.pid) } }) + '\\n');
        while (true) {}
      }, undefined, { reserve() {
        record({ state: 'reserved' });
        return { spawned(identity) { record({ state: 'spawned', identity }); },
          settled() { record({ state: 'settled' }); } };
      } });
    `;
    const controller = new AbortController();
    let ready: { root: number; identity: CommandProcessIdentity } | undefined;
    let output = "";
    try {
      const result = await runUtf8CommandWithTimeout(
        [
          node,
          ...(spawnOwner.pathname.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []),
          "--input-type=module",
          "-e",
          script,
        ],
        {
          cwd: process.cwd(),
          env: { OPENCLAW_STATE_DIR: root },
          signal: AbortSignal.any([signal, controller.signal]),
          timeoutMs: 30_000,
          killGraceMs: 100,
          killProcessTree: true,
          requireProcessTreeExtinction: true,
          onOutputChunk(chunk, stream) {
            if (stream !== "stdout") {
              return;
            }
            output += chunk.toString();
            if (!ready && output.includes("\n")) {
              ready = JSON.parse(output.split("\n")[0]!) as typeof ready;
              controller.abort();
            }
          },
        },
      );
      expect(ready, result.stderr).toBeDefined();
      if (!ready) {
        throw new Error("Custody fixture did not reach its busy operation");
      }
      expect(result.cleanup).toBe("forced");
      expect(isChildProcessTreeAlive({ pid: ready.root })).toBe(false);
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({
        state: "spawned",
        identity: ready.identity,
      });
      process.kill(ready.identity.pid, "SIGUSR2");
      await withinTest(receipts.waitFor(effect, "written"), signal);
      expect(readFileSync(effect, "utf8")).toBe("still writable");
      expect(await settleCommandProcessGroups([ready.identity])).toEqual({
        settled: true,
        pids: [],
      });
      expect(isChildProcessTreeAlive(ready.identity)).toBe(false);
    } finally {
      const identity =
        ready?.identity ??
        (existsSync(receipt)
          ? (JSON.parse(readFileSync(receipt, "utf8")) as { identity?: CommandProcessIdentity })
              .identity
          : undefined);
      if (identity) {
        const cleanup = await settleCommandProcessGroups([identity]);
        expect(cleanup, "fixture writer cleanup must remain owned").toEqual({
          settled: true,
          pids: [],
        });
      }
    }
  },
);
