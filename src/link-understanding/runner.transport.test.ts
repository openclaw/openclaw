import { existsSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, expect, it, vi, type TestContext } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { withinTest } from "../../test/helpers/promise.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore as deferred } from "../shared/deferred.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { killPidIfAlive, readPidFile } from "../test-utils/process-tree.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { applyLinkUnderstanding } from "./apply.js";

const mocks = vi.hoisted(() => ({
  bodyCancel: vi.fn(),
  releaseAfterCancel: vi.fn(),
  runCommandWithTimeout: vi.fn(),
}));
vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/net/fetch-guard.js")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) => {
      // Keep the real guarded transport while allowing only this test's loopback server.
      const result = await actual.fetchWithSsrFGuard({
        ...params,
        lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
        policy: { ...params.policy, allowPrivateNetwork: true },
      });
      const body = result.response.body;
      if (body) {
        const cancel = body.cancel.bind(body);
        vi.spyOn(body, "cancel").mockImplementation(async (reason?: unknown) => {
          mocks.bodyCancel(reason);
          await cancel(reason);
        });
      }
      const release = result.release;
      result.release = async () => {
        mocks.releaseAfterCancel(mocks.bodyCancel.mock.calls.length > 0);
        await release();
      };
      return result;
    },
  };
});
vi.mock("../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/exec.js")>();
  return {
    ...actual,
    runCommandWithTimeout: mocks.runCommandWithTimeout.mockImplementation(
      actual.runCommandWithTimeout,
    ),
  };
});

async function serve(handler: RequestListener, onTestFinished: TestContext["onTestFinished"]) {
  const server = createServer(handler);
  const base = await listenLoopback(server);
  onTestFinished(() => closeHttpServer(server));
  return base.replace("127.0.0.1", "loopback.test");
}

const echoStdin = ["-e", "process.stdin.pipe(process.stdout)"];
function startLink(Body: string, args = echoStdin, timeoutSeconds = 10) {
  const ctx: MsgContext = { Body };
  const original = { ...ctx };
  const controller = new AbortController();
  const models = [{ command: process.execPath, args, timeoutSeconds: 10 }];
  const cfg: OpenClawConfig = { tools: { links: { models, timeoutSeconds } } };
  const result = applyLinkUnderstanding({ ctx, cfg, signal: controller.signal });
  return { ctx, original, controller, result };
}

beforeEach(vi.clearAllMocks);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts?.close());

it("cancels a non-OK response body before releasing its guarded transport", async (t) => {
  const requestSocketClosed = deferred();
  const base = await serve((request, response) => {
    request.socket.once("close", requestSocketClosed.resolve);
    response.writeHead(500, { "content-length": "1000000", "content-type": "text/plain" });
    // Leave the declared body unfinished so cleanup must actively cancel it.
    response.write("error");
  }, t.onTestFinished);
  const { ctx, original, result } = startLink(`see ${base}/error`);
  await withinTest(result, t.signal);
  expect(ctx).toEqual(original);
  await withinTest(requestSocketClosed.promise, t.signal);
  expect(mocks.bodyCancel).toHaveBeenCalledOnce();
  expect(mocks.releaseAfterCancel).toHaveBeenCalledWith(true);
  expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
});

it("cancels a streaming response and preserves the unmodified inbound context", async (t) => {
  const requestStarted = deferred();
  const socketClosed = deferred();
  const requests: string[] = [];
  const base = await serve((req, res) => {
    requests.push(req.url ?? "");
    req.socket.once("close", socketClosed.resolve);
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("partial page");
    requestStarted.resolve();
  }, t.onTestFinished);
  const { ctx, original, controller, result } = startLink(`${base}/first ${base}/second`, [
    "-e",
    "throw new Error('processor must not start')",
  ]);
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await requestStarted.promise;
  controller.abort(new Error("operator stopped the reply"));
  await rejected;
  await socketClosed.promise;
  expect(ctx).toEqual(original);
  expect(requests).toEqual(["/first"]);
});

it("skips a timed-out streaming link and processes the next link", async (t) => {
  const base = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    if (req.url === "/slow") {
      res.write("unfinished");
    } else {
      res.end("complete page");
    }
  }, t.onTestFinished);
  const { ctx, result } = startLink(`${base}/slow ${base}/good`, undefined, 0.5);
  await result;
  expect(ctx.LinkUnderstanding).toEqual(["complete page"]);
});

it("fetches bare URLs in order while ignoring titled markdown links", async (t) => {
  const requests: string[] = [];
  const base = await serve((req, res) => {
    const requestPath = req.url ?? "";
    requests.push(requestPath);
    res.end(requestPath);
  }, t.onTestFinished);
  const { ctx, result } = startLink(
    [
      `[quoted](${base}/quoted "Docs")`,
      `${base}/bare-one`,
      `[angle](<${base}/angle> 'Docs')`,
      `${base}/bare-two`,
    ].join(" "),
  );
  await result;
  expect(requests).toEqual(["/bare-one", "/bare-two"]);
  expect(ctx.LinkUnderstanding).toEqual(["/bare-one", "/bare-two"]);
});

it("stops processor descendants after caller cancellation", async (t) => {
  await withTempDir("openclaw-link-cancel-", async (dir) => {
    const pidPath = path.join(dir, "worker.pid");
    const workerSource = "setInterval(() => {}, 1000); process.send('ready')";
    const wrapperSource = [
      fixtureReceiptClientSource(receipts.endpoint),
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      `const worker = spawn(process.execPath, ['-e', ${JSON.stringify(workerSource)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })`,
      `worker.once('message', () => { writeFileSync(${JSON.stringify(pidPath)}, String(worker.pid)); sendReceipt(${JSON.stringify(pidPath)}, 'ready'); })`,
      "process.stdin.resume()",
    ].join(";");
    const base = await serve((_req, res) => res.end("page body"), t.onTestFinished);
    let workerPid: number | undefined;
    const { ctx, original, controller, result } = startLink(`${base}/page`, [
      "--input-type=module",
      "-e",
      wrapperSource,
    ]);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    try {
      // IPC readiness is recorded before the socket receipt, which can arrive after settlement.
      const requirePidFile = (error: unknown) => {
        if (!existsSync(pidPath)) {
          throw error;
        }
      };
      const settled = result.then(
        () => requirePidFile(new Error(`Timed out waiting for pid file: ${pidPath}`)),
        requirePidFile,
      );
      await withinTest(Promise.race([receipts.waitFor(pidPath, "ready"), settled]), t.signal);
      workerPid = await readPidFile(pidPath);
      expect(isPidAlive(workerPid)).toBe(true);
      controller.abort();
      await withinTest(rejected, t.signal);
      expect(ctx).toEqual(original);
      // Caller rejection does not expose the adopted worker's native reap event.
      while (isPidAlive(workerPid)) {
        await delay(25, undefined, { signal: t.signal }).catch((error: unknown) => {
          throw new Error(`Processor descendant ${workerPid} stayed alive`, { cause: error });
        });
      }
      expect(isPidAlive(workerPid)).toBe(false);
    } finally {
      controller.abort();
      killPidIfAlive(workerPid);
      await rejected;
    }
  });
});
