import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import type { GatewaySessionRow as SessionRow } from "../api/types.ts";

if (process.env.OPENCLAW_PEER_RESTART_LIVE !== "1") {
  it.skip("peer restart browser proof requires OPENCLAW_PEER_RESTART_LIVE=1", () => {});
} else {
  // Skipped ordinary suites must not load the Gateway or browser fixture graph.
  const [
    { createOpenClawTestInstance },
    { runQaGatewayFixture },
    { withinTest },
    { reserveTestPortListener },
    { createDeferredCore },
    { asOptionalRecord: record },
    { pairControlUiPage },
    { evaluateControlUiContext },
    { waitForControlUiGatewayReady },
    { takeControlUiScreenshotFrame },
    { controlUiSessionUrl },
    { createControlUiE2eSuite },
  ] = await Promise.all([
    import("../../../test/helpers/openclaw-test-instance.ts"),
    import("../../../test/helpers/qa-gateway-cleanup.ts"),
    import("../../../test/helpers/promise.ts"),
    import("../../../src/test-utils/port-claims.ts"),
    import("../../../src/shared/deferred.ts"),
    import("@openclaw/normalization-core/record-coerce"),
    import("../test-helpers/control-ui-browser-pairing.ts"),
    import("../test-helpers/control-ui-e2e-context.ts"),
    import("../test-helpers/control-ui-e2e-readiness.ts"),
    import("../test-helpers/control-ui-e2e-screenshot.ts"),
    import("../test-helpers/control-ui-e2e.ts"),
    import("./control-ui-e2e-suite.test-support.ts"),
  ]);

  const sourceKey = "agent:main:peer-restart-source";
  const targetKey = "agent:main:peer-restart-target";
  const effectFile = "peer-restart-effect.txt";
  const effect = "PEER_EFFECT_COMMITTED";
  const finalAnswer = "PEER_RESTART_FINISHED";
  const delegated = "PEER_TASK_ACCEPTED";
  const viewport = { width: 1440, height: 1000 };
  const modelRef = process.env.OPENCLAW_LIVE_PEER_RESTART_MODEL?.trim() ?? "";
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const noProxy = [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
    .filter(Boolean)
    .join(",");
  let instance: OpenClawTestInstance | undefined;
  let gate: Awaited<ReturnType<typeof startGate>> | undefined;
  const sanitize = (value: string) =>
    [
      apiKey,
      modelRef,
      modelRef.slice("openai/".length),
      instance?.gatewayToken,
      instance?.hookToken,
      instance?.stateDir,
      instance?.homeDir,
    ].reduce<string>(
      (text, secret) => (secret ? text.replaceAll(secret, "[redacted]") : text),
      value,
    );

  // This is not an inference fixture. The first real exec fetch remains unresolved;
  // only a fetch issued after the old process has died can return the final marker.
  async function startGate() {
    const blocked = createDeferredCore();
    const resumed = createDeferredCore();
    const held = new Set<ServerResponse>();
    let afterCrash = false;
    let requestsBeforeCrash = 0;
    const reservation = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          if (request.method !== "GET" || request.url !== "/continue") {
            response.writeHead(404).end();
            return;
          }
          if (afterCrash) {
            response.writeHead(200, { "content-type": "text/plain" }).end(finalAnswer);
            resumed.resolve();
          } else {
            requestsBeforeCrash++;
            held.add(response);
            response.on("close", () => held.delete(response));
            blocked.resolve();
          }
        }),
    });
    return {
      url: "http://127.0.0.1:" + reservation.claim.port + "/continue",
      blocked: blocked.promise,
      resumed: resumed.promise,
      beforeCrashRequests: () => requestsBeforeCrash,
      openAfterCrash() {
        afterCrash = true;
        for (const response of held) {
          response.destroy();
        }
      },
      close: () =>
        runQaGatewayFixture(
          async () => reservation.listener.closeAllConnections(),
          reservation.releaseListener,
          reservation.claim.release,
        ),
    };
  }

  async function rpc<T>(page: Page, method: string, params: Record<string, unknown>): Promise<T> {
    return await evaluateControlUiContext(
      page,
      async (context, request) => {
        const client = context.gateway.snapshot.client;
        if (!client) {
          throw new Error("Authenticated browser Gateway client missing");
        }
        return await client.request<T>(request.method, request.params);
      },
      { method, params },
    );
  }
  type History = { messages?: unknown[] };
  const messages = (history: History) =>
    (history.messages ?? []).map((entry) => {
      const envelope = record(entry);
      return record(envelope?.message) ?? envelope ?? {};
    });
  const completedDelegation = (history: History) =>
    messages(history).some(
      (message) =>
        message.role === "toolResult" &&
        message.toolName === "sessions_send" &&
        message.isError !== true &&
        JSON.stringify(message).includes(targetKey),
    );
  const assistantBlocks = (history: History) =>
    messages(history).flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.map(record)
        : [],
    );
  const hasAssistantText = (history: History, expected: string) =>
    assistantBlocks(history).some(
      (block) =>
        block?.type === "text" && typeof block.text === "string" && block.text.trim() === expected,
    );
  const completedEffects = (history: History) =>
    messages(history).filter(
      (message) =>
        message.role === "toolResult" &&
        message.toolName === "exec" &&
        record(message.details)?.exitCode === 0 &&
        message.isError !== true &&
        JSON.stringify(message.content).includes(effect),
    );
  const poll = <T>(read: () => T | Promise<T>) => expect.poll(read, { timeout: 30_000 });

  const suite = createControlUiE2eSuite({
    name: "Peer followup live browser restart",
    startServerBeforeBrowser: true,
    setupTimeoutMs: 150_000,
    teardownTimeoutMs: 30_000,
    async startServer() {
      if (process.platform === "win32") {
        throw new Error("This SIGKILL proof requires a POSIX host");
      }
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required; its value is never retained in proof");
      }
      if (!modelRef.startsWith("openai/") || modelRef.length <= "openai/".length) {
        throw new Error(
          "Set OPENCLAW_LIVE_PEER_RESTART_MODEL to an authorized openai/<model> reference",
        );
      }
      // The parent/operator owns building. Never silently launch a build from this proof.
      await Promise.all([readFile("dist/index.js"), readFile("dist/control-ui/index.html")]);
      const close = () =>
        runQaGatewayFixture(
          async () => instance?.cleanup(),
          () => gate?.close(),
        );
      try {
        gate = await startGate();
        instance = await createOpenClawTestInstance({
          name: "peer-followup-live-restart",
          entrypoint: ["dist/index.js"],
          startTimeoutMs: 120_000,
          stopTimeoutMs: 10_000,
          env: {
            NO_PROXY: noProxy,
            no_proxy: noProxy,
            OPENAI_API_KEY: apiKey,
            OPENAI_BASE_URL: undefined,
            OPENAI_API_BASE: undefined,
            OPENCLAW_SKIP_PROVIDERS: undefined,
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENCLAW_NO_RESPAWN: "1",
            VITEST: undefined,
          },
        });
        await instance.state.writeConfig({
          update: { checkOnStart: false },
          browser: { enabled: false },
          discovery: { mdns: { mode: "off" } },
          cron: { enabled: false },
          plugins: { enabled: false },
          secrets: { providers: { default: { source: "env", allowlist: ["OPENAI_API_KEY"] } } },
          models: {
            mode: "replace",
            catalogRefresh: { enabled: false },
            providers: {
              openai: {
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                models: [
                  {
                    id: modelRef.slice("openai/".length),
                    name: "Live OpenAI proof model",
                    reasoning: true,
                    input: ["text"],
                    contextWindow: 128_000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
          agents: {
            defaults: {
              workspace: instance.state.workspaceDir,
              model: { primary: modelRef },
              modelPolicy: { allow: [modelRef] },
              models: {
                [modelRef]: {
                  agentRuntime: { id: "openclaw" },
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
              thinkingDefault: "low",
              heartbeat: { every: "0m" },
              skipBootstrap: true,
              skills: [],
              timeoutSeconds: 240,
            },
            entries: { main: { identity: { name: "Restart proof" } } },
          },
          tools: {
            allow: ["exec", "process", "sessions_send"],
            codeMode: { enabled: false },
            toolSearch: false,
            sessions: { visibility: "all" },
            exec: { host: "gateway", mode: "full" },
          },
          gateway: {
            mode: "local",
            bind: "loopback",
            port: instance.port,
            auth: { mode: "token", token: instance.gatewayToken },
            controlUi: { enabled: true },
          },
        });
        await instance.startGateway();
        return { baseUrl: "http://127.0.0.1:" + instance.port + "/", close };
      } catch (error) {
        return await runQaGatewayFixture(async (): Promise<never> => {
          throw error;
        }, close);
      }
    },
  });

  suite.define(() => {
    it("automatically finishes an authenticated peer task without replaying its completed effect", async (test) => {
      await suite.runScenario(test, {
        retainedState: () => instance?.stateDir,
        run: async (signal) => {
          const owner = instance!;
          const commandGate = gate!;
          await suite.withPage(
            { viewport, locale: "en-US", serviceWorkers: "block" },
            async ({ page, context }) => {
              const sent: string[] = [];
              const errors: string[] = [];
              page.on("websocket", (socket) => {
                socket.on("framesent", ({ payload }) => {
                  const frame = record(JSON.parse(String(payload)));
                  if (frame?.type === "req" && typeof frame.method === "string") {
                    sent.push(frame.method);
                  }
                });
                socket.on("framereceived", ({ payload }) => {
                  const frame = record(JSON.parse(String(payload)));
                  const event = record(frame?.payload);
                  if (
                    frame?.type === "event" &&
                    frame.event === "chat" &&
                    event?.sessionKey === targetKey &&
                    event.state === "error"
                  ) {
                    errors.push(sanitize(JSON.stringify(event)));
                  }
                });
              });
              const history = (key: string) =>
                rpc<History>(page, "chat.history", {
                  sessionKey: key,
                  limit: 100,
                  toolResultMaxChars: 20_000,
                });
              const rows = async () =>
                (await rpc<{ sessions: SessionRow[] }>(page, "sessions.list", { agentId: "main" }))
                  .sessions;
              const targetRow = async () => (await rows()).find((row) => row.key === targetKey);
              const readEffect = () =>
                readFile(path.join(owner.state.workspaceDir, effectFile), "utf8");
              const capture = async (name: string, surface: Locator) => {
                // Crop the transcript only; exclude model metadata, controls, and auth-bearing URLs.
                const text = (await surface.textContent()) ?? "";
                expect(sanitize(text), "Screenshot surface contains private fixture data").toBe(
                  text,
                );
                expect(new URL(page.url()).hash).toBe("");
                const frame = await takeControlUiScreenshotFrame(page, surface, [surface], {
                  elements: [surface],
                  animations: "disabled",
                });
                await writeFile(
                  path.join(suite.artifactDir, name + ".png"),
                  frame.elements[0]!.png,
                );
              };
              try {
                await page.addInitScript(() =>
                  localStorage.setItem(
                    "openclaw:control-ui:community-invite:v2",
                    JSON.stringify({ dismissedAtMs: 1770000000000 }),
                  ),
                );
                await pairControlUiPage(page, async (args) => {
                  const result = await owner.cli(args);
                  if (result.code !== 0) {
                    throw new Error(sanitize(result.stderr));
                  }
                  return result.stdout;
                });
                for (const [key, label] of [
                  [sourceKey, "Peer restart source"],
                  [targetKey, "Peer restart target"],
                ]) {
                  await rpc(page, "sessions.create", {
                    key,
                    agentId: "main",
                    label,
                    permissionMode: "full",
                  });
                }
                await page.goto(controlUiSessionUrl(suite.server.baseUrl, sourceKey));
                await waitForControlUiGatewayReady(page);
                const assetPath = await page
                  .locator('script[type="module"][src]')
                  .first()
                  .getAttribute("src");
                expect(assetPath).toMatch(/^\/assets\/.+\.js$/);
                const asset = await context.request.get(
                  new URL(assetPath!, suite.server.baseUrl).href,
                );
                expect(asset.ok()).toBe(true);
                const assetBytes = await asset.body();
                expect(
                  assetBytes.equals(
                    await readFile(path.join("dist/control-ui", assetPath!.slice(1))),
                  ),
                ).toBe(true);

                const effectCommand = "echo " + effect + " >> " + effectFile + "; echo " + effect;
                const safeCommand =
                  "node -e " +
                  JSON.stringify(
                    `fetch('${commandGate.url}').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }).then(console.log).catch(e => { console.error(e.message); process.exitCode = 1; })`,
                  );
                const targetTask = [
                  "Perform this small task in order. First use exec exactly once for this command, wait for its successful result, and preserve that completed result:",
                  effectCommand,
                  "Then use a separate exec for this read-only HTTP command (timeout 180 seconds), waiting for its output:",
                  safeCommand,
                  "After the HTTP command succeeds, reply with exactly its response text. Do not call sessions_send or announce back to the source.",
                ].join("\n");
                const prompt = [
                  `Use sessions_send once with sessionKey=${targetKey}, mode=followup, timeoutSeconds=0, and this exact message:`,
                  targetTask,
                  `After acceptance, reply only ${delegated}. Do not run the commands yourself or wait for the peer.`,
                ].join("\n");
                const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
                await pane
                  .getByRole("textbox", { name: "Chat composer", exact: true })
                  .fill(prompt);
                await pane.getByRole("button", { name: "Send message", exact: true }).click();
                await withinTest(commandGate.blocked, signal);
                await poll(async () => completedDelegation(await history(sourceKey))).toBe(true);
                await poll(async () => hasAssistantText(await history(sourceKey), delegated)).toBe(
                  true,
                );
                const beforeHistory = await history(targetKey);
                const completedEffect = completedEffects(beforeHistory)[0];
                expect(completedEffect?.toolCallId).toEqual(expect.any(String));
                // Match the target's actual exec, not a URL in its prompt or the source's command.
                expect(
                  assistantBlocks(beforeHistory).some((block) => {
                    const command = record(block?.arguments)?.command;
                    return (
                      block?.type === "toolCall" &&
                      block.name === "exec" &&
                      typeof command === "string" &&
                      command.includes(commandGate.url)
                    );
                  }),
                ).toBe(true);
                expect(await readEffect()).toBe(effect + "\n");
                const before = await targetRow();
                expect(before?.sessionId).toEqual(expect.stringMatching(/./s));
                await page.goto(controlUiSessionUrl(suite.server.baseUrl, targetKey));
                await waitForControlUiGatewayReady(page);
                const thread = pane.locator(".chat-thread");
                await capture("01-before-crash", thread);
                expect(commandGate.beforeCrashRequests()).toBe(1);

                const child = owner.child;
                if (!child?.pid) {
                  throw new Error("Owned Gateway child missing");
                }
                const oldPid = child.pid;
                const crashed = once(child, "close");
                expect(child.kill("SIGKILL")).toBe(true);
                await withinTest(crashed, signal);
                expect(child.signalCode).toBe("SIGKILL");
                commandGate.openAfterCrash();
                const sendCountAtCrash = sent.filter((method) => method === "chat.send").length;
                expect(sendCountAtCrash).toBe(1);
                await owner.startGateway();
                expect(owner.child?.pid).not.toBe(oldPid);
                await waitForControlUiGatewayReady(page);
                await withinTest(commandGate.resumed, signal);
                const answer = pane
                  .locator(".chat-group.assistant .chat-text")
                  .filter({ hasText: finalAnswer })
                  .last();
                await answer.waitFor({ state: "visible", timeout: 120_000 });
                await poll(async () => (await targetRow())?.status).toBe("done");
                const after = await targetRow();
                expect(after).toMatchObject({
                  sessionId: before!.sessionId,
                  status: "done",
                  hasActiveRun: false,
                });
                expect(after?.restartRecoveryStatus).toBeUndefined();
                expect(after?.lastRunError).toBeUndefined();
                expect(errors).toEqual([]);
                expect(sent.filter((method) => method === "chat.send")).toHaveLength(
                  sendCountAtCrash,
                );
                expect(sent).not.toContain("sessions.recover");
                const afterHistory = await history(targetKey);
                expect(hasAssistantText(afterHistory, finalAnswer)).toBe(true);
                const effects = completedEffects(afterHistory).filter(
                  (message) => message.toolCallId === completedEffect!.toolCallId,
                );
                expect(effects).toHaveLength(1);
                expect(await readEffect()).toBe(effect + "\n");
                // Capture only the answer; the collapsed group still contains private tool/model metadata.
                await capture("02-automatically-finished", answer);
              } catch (error) {
                const failure = sanitize(
                  error instanceof Error ? (error.stack ?? error.message) : String(error),
                );
                throw new Error("Peer restart live proof failed: " + failure, { cause: error });
              }
            },
          );
        },
      });
    }, 300_000);
  });
}
