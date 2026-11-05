import { existsSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
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
        vi.spyOn(body, "cancel").mockImplementation(mocks.bodyCancel.mockImplementation(cancel));
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

async function serve(handler: RequestListener) {
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
  const cfg: OpenClawConfig = { tools: { links: { models, timeoutSeconds, maxLinks: 3 } } };
  const result = applyLinkUnderstanding({ ctx, cfg, signal: controller.signal });
  return { ctx, original, controller, result };
}

beforeEach(vi.clearAllMocks);

it("cancels a non-OK response body before releasing its guarded transport", async (t) => {
  const requestSocketClosed = deferred();
  const base = await serve((request, response) => {
    request.socket.once("close", requestSocketClosed.resolve);
    response.writeHead(500, { "content-length": "1000000", "content-type": "text/plain" });
    // Leave the declared body unfinished so cleanup must actively cancel it.
    response.write("error");
  });
  const { ctx, original, result } = startLink(`see ${base}/error`);
  await withinTest(result, t.signal);
  expect(ctx).toEqual(original);
  await withinTest(requestSocketClosed.promise, t.signal);
  expect(mocks.bodyCancel).toHaveBeenCalledOnce();
  expect(mocks.releaseAfterCancel).toHaveBeenCalledWith(true);
});

it.each(["cancel", "timeout"])("handles %s during a streaming response", async (mode) => {
  const requestStarted = deferred();
  const socketClosed = deferred();
  const requests: string[] = [];
  const base = await serve((req, res) => {
    requests.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain" });
    if (req.url === "/second") {
      res.end("complete page");
      return;
    }
    req.socket.once("close", socketClosed.resolve);
    res.write("partial page");
    requestStarted.resolve();
  });
  const { ctx, original, controller, result } = startLink(
    `${base}/first ${base}/second`,
    mode === "cancel" ? ["-e", "throw new Error('processor must not start')"] : undefined,
    mode === "cancel" ? 10 : 0.5,
  );
  if (mode === "cancel") {
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await requestStarted.promise;
    controller.abort(new Error("operator stopped the reply"));
    await rejected;
    expect(ctx).toEqual(original);
    expect(requests).toEqual(["/first"]);
  } else {
    await result;
    expect(ctx.LinkUnderstanding).toEqual(["complete page"]);
  }
  await socketClosed.promise;
});

it("decodes declared charsets while deduping and limiting bare URLs", async () => {
  const requests: string[] = [];
  const base = await serve((req, res) => {
    requests.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain; charset=Shift_JIS" });
    res.end(req.url === "/bare-one" ? Buffer.from([147, 250, 150, 123, 140, 234]) : req.url);
  });
  const { ctx, result } = startLink(
    [
      `[quoted](${base}/quoted "Docs")`,
      `${base}/bare-one`,
      `${base}/bare-one`,
      `[angle](<${base}/angle> 'Docs')`,
      `[nested [label]](${base}/nested)`,
      `[multiline](${base}/multiline "one\ntwo")`,
      `[escaped](${base}/escaped "t\\")`,
      `${base}/bare-two`,
      `${base}/over-limit`,
    ].join(" "),
  );
  await result;
  expect(requests).toEqual(["/bare-one", "/escaped", "/bare-two"]);
  expect(ctx.LinkUnderstanding).toEqual(["日本語", "/escaped", "/bare-two"]);
});

it.each(["[1]", "[{base}/label][1]", "![{base}/label][1]"])(
  "preserves the pasted-link budget after reference syntax %s",
  async (label) => {
    const requests: string[] = [];
    const base = await serve((req, res) => {
      requests.push(req.url ?? "");
      res.end(req.url);
    });
    const ctx: MsgContext = {
      Body: `${label.replace("{base}", base)}\n\n[1]: ${base}/citation\n\nRead ${base}/pasted`,
    };
    await applyLinkUnderstanding({
      ctx,
      cfg: {
        tools: {
          links: { maxLinks: 1, models: [{ command: process.execPath, args: echoStdin }] },
        },
      },
    });
    expect(requests).toEqual(["/pasted"]);
    expect(ctx.LinkUnderstanding).toEqual(["/pasted"]);
    expect(ctx.BodyForAgent).toContain("\n\n/pasted");
  },
);

it("stops processor descendants after caller cancellation", async (t) => {
  const receipts = await openFixtureReceiptChannel();
  onTestFinished(() => receipts.close());
  await withTempDir("openclaw-link-cancel-", async (dir) => {
    const pidPath = path.join(dir, "worker.pid");
    const wrapperSource = [
      fixtureReceiptClientSource(receipts.endpoint),
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      "const worker = spawn(process.execPath, ['-e', \"setInterval(() => {}, 1000); process.send('ready')\"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })",
      `worker.once('message', () => { writeFileSync(${JSON.stringify(pidPath)}, String(worker.pid)); sendReceipt(${JSON.stringify(pidPath)}, 'ready'); })`,
      "process.stdin.resume()",
    ].join(";");
    const base = await serve((_req, res) => res.end("page body"));
    let workerPid: number | undefined;
    const { ctx, original, controller, result } = startLink(`${base}/page`, [
      "--input-type=module",
      "-e",
      wrapperSource,
    ]);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    try {
      // IPC readiness is recorded before the socket receipt, which can arrive after settlement.
      const settled = result.catch((error: unknown) => {
        if (!existsSync(pidPath)) {
          throw error;
        }
      });
      await withinTest(Promise.race([receipts.waitFor(pidPath, "ready"), settled]), t.signal);
      workerPid = await readPidFile(pidPath);
      expect(isPidAlive(workerPid)).toBe(true);
      controller.abort();
      await withinTest(rejected, t.signal);
      expect(ctx).toEqual(original);
      // Caller rejection does not expose the adopted worker's native reap event.
      while (isPidAlive(workerPid)) {
        await delay(25, undefined, { signal: t.signal });
      }
      expect(isPidAlive(workerPid)).toBe(false);
    } finally {
      controller.abort();
      killPidIfAlive(workerPid);
      await rejected;
    }
  });
});
