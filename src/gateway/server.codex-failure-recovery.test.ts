import childProcess, { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import nodeProcess from "node:process";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { captureEnv } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

type ProviderRequest = {
  body: string;
  threadId: string | string[] | undefined;
};

type ReadyThread = {
  threadId: string;
  clientId: string;
  action: string;
};

const cases: Array<{
  name: string;
  failFirst: boolean;
  activeSibling?: boolean;
  idleSibling?: "incognito" | "persistent";
  shutdown?: "delayed" | "cancelled" | "unconfirmed";
}> = [
  {
    name: "leaves active siblings alone",
    failFirst: true,
    activeSibling: true,
  },
  {
    name: "reloads a healthy thread",
    failFirst: false,
    activeSibling: false,
  },
  { name: "preserves an idle Incognito sibling", failFirst: true, idleSibling: "incognito" },
  { name: "cold resumes an idle persistent sibling", failFirst: true, idleSibling: "persistent" },
  { name: "waits for physical exit before recovery", failFirst: true, shutdown: "delayed" },
  {
    name: "cancels during physical exit without reacquisition",
    failFirst: true,
    shutdown: "cancelled",
  },
  {
    name: "preserves its binding when physical exit is unconfirmed",
    failFirst: true,
    shutdown: "unconfirmed",
  },
];

it.each(cases)(
  "chat.send $name",
  { timeout: 180_000 },
  async ({ failFirst, activeSibling, idleSibling, shutdown }) => {
    const dirs = useAutoCleanupTempDirTracker(onTestFinished);
    const root = await fs.realpath(dirs.make("gateway-native-recovery-"));
    const workspace = path.join(root, "workspace");
    const state = path.join(root, "state");
    const plugin = path.join(root, "instruction-plugin");
    await Promise.all([workspace, state, plugin].map((dir) => fs.mkdir(dir, { recursive: true })));
    const instruction = path.join(root, "instructions.txt");
    await fs.writeFile(instruction, "INITIAL_POLICY");
    await fs.writeFile(
      path.join(plugin, "openclaw.plugin.json"),
      JSON.stringify({
        id: "recovery-instructions",
        activation: { onStartup: true },
        configSchema: { type: "object", properties: {}, additionalProperties: false },
      }),
    );
    await fs.writeFile(
      path.join(plugin, "index.js"),
      [
        'const fs = require("node:fs");',
        "module.exports = {",
        '  id: "recovery-instructions",',
        "  register(api) {",
        '    api.on("before_prompt_build", () => ({',
        `      systemPrompt: fs.readFileSync(${JSON.stringify(instruction)}, "utf8"),`,
        "    }));",
        "  },",
        "};",
      ].join("\n"),
    );

    const nativeProcesses = new Map<ChildProcess, { output: string }>();
    if (shutdown) {
      const spawn = childProcess.spawn;
      const spawnSpy = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
        const child = spawn(...args);
        if (Array.isArray(args[1]) && args[1].includes("app-server")) {
          const captured = { output: "" };
          nativeProcesses.set(child, captured);
          child.stdout?.on("data", (chunk: Buffer) => {
            captured.output += chunk.toString();
          });
        }
        return child;
      });
      syncBuiltinESMExports();
      onTestFinished(() => {
        spawnSpy.mockRestore();
        syncBuiltinESMExports();
      });
    }
    const requests: ProviderRequest[] = [];
    const idleSiblingRequests: ProviderRequest[] = [];
    const primaryRequests: ProviderRequest[] = [];
    const siblingReceived = createDeferred<ProviderRequest>();
    const releaseSibling = createDeferred();
    const server = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        // 426 negotiates native HTTP fallback without retrying WebSocket handshakes.
        res.writeHead(req.method === "GET" && req.url === "/v1/responses" ? 426 : 404).end();
        return;
      }
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        const request = { body, threadId: req.headers["thread-id"] };
        requests.push(request);
        if (body.includes("IDLE_SIBLING_CONTEXT")) {
          idleSiblingRequests.push(request);
          writeOpenAiResponsesText(res, {
            text: "IDLE_SIBLING_REPLY",
            messageId: `idle-${idleSiblingRequests.length}`,
            responseId: `idle-response-${idleSiblingRequests.length}`,
          });
          return;
        }
        if (body.includes("SIBLING_HELD")) {
          siblingReceived.resolve(request);
          void releaseSibling.promise.then(() => {
            writeOpenAiResponsesText(res, {
              text: "SIBLING_COMPLETE",
              messageId: "sibling-message",
              responseId: "sibling-response",
            });
          });
          return;
        }
        primaryRequests.push(request);
        if (failFirst && primaryRequests.length === 1) {
          res.writeHead(400, { "content-type": "application/json" }).end(
            JSON.stringify({
              error: {
                message: "controlled settled failure",
                type: "invalid_request_error",
                code: "invalid_request",
              },
            }),
          );
          return;
        }
        writeOpenAiResponsesText(res, {
          text: primaryRequests.length === 1 ? "INITIAL_REPLY" : "HISTORY_ALPHA NEW_POLICY_BETA",
          messageId: `primary-message-${primaryRequests.length}`,
          responseId: `primary-response-${primaryRequests.length}`,
        });
      });
    });
    onTestFinished(async () => {
      releaseSibling.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address && typeof address !== "string", "controlled provider must bind a local port");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const values = {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: path.join(root, ".codex"),
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      OPENCLAW_GATEWAY_TOKEN: "synthetic-recovery-token",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      OPENCLAW_AGENT_RUNTIME: "codex",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "0",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "dist/extensions"),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost,::1",
    };
    const env = captureEnv(Object.keys(values));
    Object.assign(process.env, values);
    onTestFinished(() => env.restore());
    const model = "gpt-5.5";
    const cfg = {
      gateway: {
        mode: "local",
        auth: { mode: "token", token: values.OPENCLAW_GATEWAY_TOKEN },
        controlUi: { enabled: false },
      },
      agents: {
        defaults: {
          workspace,
          skipBootstrap: true,
          utilityModel: "",
          heartbeat: { every: "0m" },
          model: { primary: `openai/${model}` },
          models: { [`openai/${model}`]: { agentRuntime: { id: "codex" } } },
          maxConcurrent: 2,
          timeoutSeconds: 60,
        },
      },
      models: {
        mode: "replace",
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "synthetic-local-only",
            api: "openai-responses",
            models: [
              {
                id: model,
                name: "Synthetic model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      },
      plugins: {
        allow: ["codex", "openai", "recovery-instructions"],
        load: { paths: [plugin] },
        entries: {
          codex: {
            enabled: true,
            config: {
              sessionCatalog: { enabled: false },
              appServer: {
                args: [
                  "app-server",
                  "--listen",
                  "stdio://",
                  "-c",
                  `openai_base_url="${baseUrl}"`,
                  "-c",
                  "analytics.enabled=false",
                  "-c",
                  "feedback.enabled=false",
                  "-c",
                  "features.shell_snapshot=false",
                ],
              },
            },
          },
          openai: { enabled: true },
          "recovery-instructions": {
            enabled: true,
            hooks: { allowPromptInjection: true, allowConversationAccess: true },
          },
        },
      },
    };
    const readyThreads = new Map<string, ReadyThread>();
    const gateway = await startGatewayWithClient({
      cfg,
      configPath: values.OPENCLAW_CONFIG_PATH,
      token: values.OPENCLAW_GATEWAY_TOKEN,
      onEvent: ({ event, payload }) => {
        if (
          event !== "agent" ||
          !isRecord(payload) ||
          payload.stream !== "codex_app_server.lifecycle" ||
          typeof payload.runId !== "string" ||
          !isRecord(payload.data) ||
          payload.data.phase !== "thread_ready"
        ) {
          return;
        }
        const { threadId, clientId, action } = payload.data;
        if (
          typeof threadId === "string" &&
          typeof clientId === "string" &&
          typeof action === "string"
        ) {
          readyThreads.set(payload.runId, { threadId, clientId, action });
        }
      },
    });
    onTestFinished(async () => {
      releaseSibling.resolve();
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close();
    });
    const runPrefix = randomUUID();
    const sessionKey = `agent:main:recovery-proof-${runPrefix}`;
    let siblingSessionKey = `agent:main:recovery-sibling-${runPrefix}`;
    const start = (message: string, idempotencyKey: string, targetSession = sessionKey) =>
      gateway.client.request<{ runId: string }>("chat.send", {
        sessionKey: targetSession,
        message,
        idempotencyKey: `${runPrefix}-${idempotencyKey}`,
        deliver: false,
      });
    const wait = (runId: string) =>
      gateway.client.request<{ status: string; error?: string }>(
        "agent.wait",
        { runId, timeoutMs: 65_000 },
        { timeoutMs: 70_000 },
      );
    const ready = (runId: string) =>
      vi.waitFor(() => {
        const thread = readyThreads.get(runId);
        assert(thread, "chat.send must publish its ready native thread and client");
        return thread;
      });
    let idleThread: ReadyThread | undefined;
    if (idleSibling) {
      if (idleSibling === "incognito") {
        const created = await gateway.client.request<{ key: string }>("sessions.create", {
          agentId: "main",
          incognito: true,
        });
        siblingSessionKey = created.key;
      }
      const idle = await start("Remember IDLE_SIBLING_CONTEXT.", "idle-first", siblingSessionKey);
      expect(await wait(idle.runId)).toMatchObject({ status: "ok" });
      idleThread = await ready(idle.runId);
    }
    const first = await start("Remember HISTORY_ALPHA.", "first");
    const settled = await wait(first.runId);
    expect(settled).toMatchObject({ status: failFirst ? "error" : "ok" });
    if (failFirst) {
      expect(settled.error).toContain("controlled settled failure");
    }
    const previous = await ready(first.runId);
    expect(previous.action).toBe("started");
    if (idleThread) {
      expect(previous.clientId).toBe(idleThread.clientId);
    }
    expect(primaryRequests).toHaveLength(1);
    expect(primaryRequests[0]).toMatchObject({
      body: expect.stringContaining("INITIAL_POLICY"),
      threadId: previous.threadId,
    });

    const assertOriginalBinding = async () => {
      const history = await gateway.client.request<{ sessionId: string }>("chat.history", {
        sessionKey,
        limit: 20,
      });
      const bindings = createPluginStateKeyedStore<unknown>("codex", {
        namespace: "app-server-thread-bindings",
        maxEntries: 50_000,
        overflowPolicy: "reject-new",
      });
      expect(await bindings.entries()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            value: expect.objectContaining({
              sessionId: history.sessionId,
              state: "active",
              binding: expect.objectContaining({ threadId: previous.threadId }),
            }),
          }),
        ]),
      );
    };
    const continueIdleSibling = async (expectedClientId: string) => {
      assert(idleThread);
      await fs.writeFile(instruction, "INITIAL_POLICY");
      const continued = await start("Continue the saved context.", "idle-next", siblingSessionKey);
      expect(await wait(continued.runId)).toMatchObject({ status: "ok" });
      expect(await ready(continued.runId)).toMatchObject({
        threadId: idleThread.threadId,
        clientId: expectedClientId,
      });
      expect(idleSiblingRequests).toHaveLength(2);
      expect(idleSiblingRequests[1]).toMatchObject({
        threadId: idleThread.threadId,
        body: expect.stringContaining("IDLE_SIBLING_CONTEXT"),
      });
      expect(idleSiblingRequests[1]?.body).toContain("INITIAL_POLICY");
      expect(idleSiblingRequests[1]?.body).not.toContain("NEW_POLICY_BETA");
    };
    let siblingRunId: string | undefined;
    if (activeSibling) {
      const sibling = await start("SIBLING_HELD", "sibling", siblingSessionKey);
      siblingRunId = sibling.runId;
      const received = await withTestTimeout(
        siblingReceived.promise,
        30_000,
        "active sibling did not reach the controlled provider",
      );
      const siblingThread = await ready(sibling.runId);
      expect(siblingThread.clientId).toBe(previous.clientId);
      expect(siblingThread.threadId).not.toBe(previous.threadId);
      expect(received.threadId).toBe(siblingThread.threadId);
    }

    await fs.writeFile(instruction, "NEW_POLICY_BETA");
    if (siblingRunId) {
      for (const key of ["second", "retry"]) {
        const refused = await start("Continue with changed instructions.", key);
        const result = await wait(refused.runId);
        expect(result.status).toBe("error");
        expect(result.error).toContain("did not confirm unloading");
        expect(readyThreads.has(refused.runId)).toBe(false);
      }
      expect(primaryRequests).toHaveLength(1);
      await assertOriginalBinding();

      releaseSibling.resolve();
      expect(await wait(siblingRunId)).toMatchObject({ status: "ok" });
      const siblingThread = await ready(siblingRunId);
      await fs.writeFile(instruction, "INITIAL_POLICY");
      const continuedSibling = await start(
        "Continue the sibling.",
        "sibling-next",
        siblingSessionKey,
      );
      expect(await wait(continuedSibling.runId)).toMatchObject({ status: "ok" });
      expect(await ready(continuedSibling.runId)).toMatchObject({
        threadId: siblingThread.threadId,
        clientId: previous.clientId,
      });
      expect(primaryRequests).toHaveLength(1);
      expect(requests).toHaveLength(3);
      return;
    }
    if (idleSibling === "incognito") {
      const refused = await start("Continue with changed instructions.", "second");
      const result = await wait(refused.runId);
      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining("did not confirm unloading"),
      });
      expect(readyThreads.has(refused.runId)).toBe(false);
      expect(primaryRequests).toHaveLength(1);
      await assertOriginalBinding();
      await continueIdleSibling(previous.clientId);
      expect(requests).toHaveLength(3);
      return;
    }
    const exitGate = shutdown
      ? holdNativeExit(nativeProcesses, previous.threadId, shutdown === "unconfirmed")
      : undefined;
    if (exitGate) {
      onTestFinished(exitGate.release);
    }
    const beforeRecoveryProcesses = nativeProcesses.size;
    const continued = await start("Continue with changed instructions.", "second");
    if (exitGate) {
      await withTestTimeout(exitGate.waiting, 10_000, "startup did not wait for physical exit");
      expect(exitGate.child.exitCode).toBeNull();
      expect(exitGate.child.signalCode).toBeNull();
      expect(nativeProcesses.size).toBe(beforeRecoveryProcesses);
      expect(primaryRequests).toHaveLength(1);
      await assertOriginalBinding();
      if (shutdown === "cancelled") {
        expect(
          await gateway.client.request("chat.abort", { sessionKey, runId: continued.runId }),
        ).toMatchObject({ aborted: true });
        expect(exitGate.child.exitCode).toBeNull();
        expect(exitGate.child.signalCode).toBeNull();
        expect(nodeProcess.kill(exitGate.pid, 0)).toBe(true);
      } else if (shutdown === "unconfirmed") {
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await wait(continued.runId)).toMatchObject({
          status: "error",
          error: expect.stringContaining("did not confirm shutdown"),
        });
      }
      exitGate.release();
      await withTestTimeout(exitGate.exited, 10_000, "old native process did not exit");
      if (shutdown !== "delayed") {
        await wait(continued.runId);
        expect(nativeProcesses.size).toBe(beforeRecoveryProcesses);
        expect(readyThreads.has(continued.runId)).toBe(false);
        expect(primaryRequests).toHaveLength(1);
        await assertOriginalBinding();
        return;
      }
    }
    expect(await wait(continued.runId)).toMatchObject({ status: "ok" });
    const recovered = await ready(continued.runId);
    expect(recovered.threadId).toBe(previous.threadId);
    expect(recovered.action).toBe("resumed");
    if (failFirst) {
      expect(recovered.clientId).not.toBe(previous.clientId);
    } else {
      expect(recovered.clientId).toBe(previous.clientId);
    }
    expect(primaryRequests).toHaveLength(2);
    expect(primaryRequests[1]).toMatchObject({
      threadId: previous.threadId,
      body: expect.stringContaining("HISTORY_ALPHA"),
    });
    expect(primaryRequests[1]).toMatchObject({ body: expect.stringContaining("NEW_POLICY_BETA") });
    const history = await gateway.client.request("chat.history", { sessionKey, limit: 20 });
    expect(JSON.stringify(history)).toContain("HISTORY_ALPHA NEW_POLICY_BETA");

    if (exitGate) {
      expect(nativeProcesses.size).toBe(beforeRecoveryProcesses + 1);
    }
    if (idleSibling === "persistent") {
      await continueIdleSibling(recovered.clientId);
    }
    expect(requests).toHaveLength(idleSibling ? 4 : 2);
  },
);

/** Hold only the observed native child's exit; protocol, writer lock and run cancellation stay real. */
function holdNativeExit(
  processes: Map<ChildProcess, { output: string }>,
  threadId: string,
  withholdExitConfirmation: boolean,
) {
  const matches = [...processes].filter(([, captured]) => captured.output.includes(threadId));
  expect(matches).toHaveLength(1);
  const child = matches[0]?.[0];
  assert(child?.stdin && child.pid, "the native thread must belong to a captured process");
  const stdin = child.stdin;
  const pid = child.pid;
  const waiting = createDeferred();
  const exited = createDeferred();
  let closing = false;
  child.once("exit", () => exited.resolve());
  const onListener = (event: string) => {
    // close() installs its exit handler before ending stdin. closeAndWait()
    // subsequently subscribes to physical exit, after closure has begun.
    if (event === "exit" && closing) {
      waiting.resolve();
    }
  };
  child.on("newListener", onListener);
  const end = vi.spyOn(stdin, "end").mockImplementation(() => {
    closing = true;
    // Hold the shutdown clock with the child: binding reads and chat.abort
    // must precede the exit deadline, even when the host is busy.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    return stdin;
  });
  const destroy = vi.spyOn(stdin, "destroy").mockImplementation(() => stdin);
  // Lost exit notification and stale child status must not become a successful
  // shutdown receipt. Keep actual Node exit state separately for teardown.
  let restoreExitConfirmation = () => {};
  if (withholdExitConfirmation) {
    let exitCode = child.exitCode;
    let signalCode = child.signalCode;
    const exitDescriptor = Object.getOwnPropertyDescriptor(child, "exitCode");
    const signalDescriptor = Object.getOwnPropertyDescriptor(child, "signalCode");
    assert(exitDescriptor && signalDescriptor);
    Object.defineProperty(child, "exitCode", {
      configurable: true,
      get: () => null,
      set: (value: typeof exitCode) => {
        exitCode = value;
      },
    });
    Object.defineProperty(child, "signalCode", {
      configurable: true,
      get: () => null,
      set: (value: typeof signalCode) => {
        signalCode = value;
      },
    });
    const once = child.once.bind(child);
    const receipt = vi.spyOn(child, "once").mockImplementation((event, listener) => {
      if (event === "exit" && closing) {
        waiting.resolve();
        return child;
      }
      return once(event, listener);
    });
    restoreExitConfirmation = () => {
      receipt.mockRestore();
      Object.defineProperty(child, "exitCode", { ...exitDescriptor, value: exitCode });
      Object.defineProperty(child, "signalCode", { ...signalDescriptor, value: signalCode });
    };
  }
  // Containment stops the launcher before killing its native child. Keep it
  // stopped after stdin closes: on resume it mirrors the child's fatal signal.
  const kill = nodeProcess.kill.bind(nodeProcess);
  const signal = vi.spyOn(nodeProcess, "kill").mockImplementation((targetPid, value) => {
    if (
      (targetPid === pid || targetPid === -pid) &&
      (value === "SIGKILL" || value === "SIGTERM" || (closing && value === "SIGCONT"))
    ) {
      return true;
    }
    return kill(targetPid, value);
  });
  syncBuiltinESMExports();
  const killChild = child.kill.bind(child);
  const childKill = vi
    .spyOn(child, "kill")
    .mockImplementation((value) =>
      value === "SIGSTOP" || (value === "SIGCONT" && !closing) ? killChild(value) : true,
    );
  let released = false;
  return {
    child,
    pid,
    waiting: waiting.promise,
    exited: exited.promise,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      vi.useRealTimers();
      child.off("newListener", onListener);
      restoreExitConfirmation();
      end.mockRestore();
      destroy.mockRestore();
      signal.mockRestore();
      syncBuiltinESMExports();
      childKill.mockRestore();
      stdin.end();
      killChild("SIGCONT");
    },
  };
}
