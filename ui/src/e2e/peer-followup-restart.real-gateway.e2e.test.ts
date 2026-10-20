// Opt-in only: real Chromium, real OpenAI inference, and one owned Gateway crash.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";

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
  const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  let instance: OpenClawTestInstance | undefined;
  let artifactDir: string | undefined;
  let gate: Awaited<ReturnType<typeof startGate>> | undefined;
  let stage = "preflight";
  const proof: Record<string, unknown> = {
    complete: false,
    scenario:
      "UI operator -> real sessions_send -> completed exec -> SIGKILL -> automatic continuation",
    provider: {
      name: "openai",
      endpoint: "https://api.openai.com/v1",
      modelEnvironment: "OPENCLAW_LIVE_PEER_RESTART_MODEL",
    },
    boundaries:
      "No provider or Gateway mocks; only a read-only loopback HTTP command is held. No sessions.recover or post-crash chat.send.",
    viewport,
  };
  const sanitize = (value: string) => {
    let text = value;
    for (const secret of [
      apiKey,
      modelRef,
      modelRef.slice("openai/".length),
      instance?.gatewayToken,
      instance?.hookToken,
      instance?.stateDir,
      instance?.homeDir,
    ]) {
      if (secret) {
        text = text.replaceAll(secret, "[redacted]");
      }
    }
    return text;
  };
  const saveProof = async () => {
    if (artifactDir) {
      await writeFile(
        path.join(artifactDir, "proof.json"),
        sanitize(JSON.stringify({ ...proof, stage }, null, 2)) + "\n",
      );
    }
  };

  // This is not an inference fixture. The first real exec fetch remains unresolved;
  // only a fetch issued after the old process has died can return the final marker.
  async function startGate() {
    const blocked = createDeferredCore();
    const resumed = createDeferredCore();
    const held = new Set<ServerResponse>();
    let afterCrash = false;
    let requestsBeforeCrash = 0;
    let requestsAfterCrash = 0;
    const reservation = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          if (request.method !== "GET" || request.url !== "/continue") {
            response.writeHead(404).end();
            return;
          }
          if (afterCrash) {
            requestsAfterCrash++;
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
      counts: () => ({ requestsBeforeCrash, requestsAfterCrash }),
      openAfterCrash() {
        afterCrash = true;
        for (const response of held) {
          response.destroy();
        }
      },
      close: () =>
        runQaGatewayFixture(
          async () => {
            reservation.listener.closeAllConnections();
          },
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
  type History = { sessionId?: string; messages?: unknown[] };
  type SessionRow = {
    key: string;
    sessionId?: string;
    status?: string;
    hasActiveRun?: boolean;
    restartRecoveryStatus?: string;
    lastRunError?: string;
  };
  const messages = (history: History) =>
    (history.messages ?? []).map((entry) => {
      const envelope = record(entry);
      return record(envelope?.message) ?? envelope ?? {};
    });
  const completedTool = (history: History, toolName: string, text: string) =>
    messages(history).some(
      (message) =>
        message.role === "toolResult" &&
        message.toolName === toolName &&
        (toolName !== "exec" || record(message.details)?.exitCode === 0) &&
        message.isError !== true &&
        JSON.stringify(message).includes(text),
    );
  const hasAssistantText = (history: History, expected: string) =>
    messages(history).some(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((value) => {
          const block = record(value);
          return (
            block?.type === "text" &&
            typeof block.text === "string" &&
            block.text.trim() === expected
          );
        }),
    );

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
          async () => {
            await instance?.cleanup();
            proof.gatewayStopped = !instance?.child;
          },
          async () => {
            await gate?.close();
            proof.gateCounts = gate?.counts();
          },
          saveProof,
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
        stage = "Gateway startup";
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
      artifactDir = suite.artifactDir;
      await suite.runScenario(test, {
        retainedState: () => instance?.stateDir,
        run: async (signal) => {
          const owner = instance!;
          const commandGate = gate!;
          await suite.withPage(
            { viewport, locale: "en-US", serviceWorkers: "block" },
            async ({ page, context }) => {
              const sent: Array<{ method: string; sessionKey?: string }> = [];
              const errors: string[] = [];
              page.on("websocket", (socket) => {
                socket.on("framesent", ({ payload }) => {
                  const frame = record(JSON.parse(String(payload)));
                  if (
                    frame?.type === "req" &&
                    typeof frame.method === "string" &&
                    frame.method !== "connect"
                  ) {
                    const params = record(frame.params);
                    sent.push({
                      method: frame.method,
                      sessionKey:
                        typeof params?.sessionKey === "string" ? params.sessionKey : undefined,
                    });
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
              const capture = async (name: string, surface: Locator, content: Locator[]) => {
                // Save only the real transcript viewport crop, excluding the model picker,
                // connection controls and sidebar. Never retain an auth-bearing page URL.
                const text = (await surface.textContent()) ?? "";
                expect(
                  sanitize(text) === text,
                  "Screenshot surface contains private fixture data",
                ).toBe(true);
                expect(new URL(page.url()).hash).toBe("");
                const frame = await takeControlUiScreenshotFrame(page, surface, content, {
                  elements: [surface],
                  animations: "disabled",
                });
                await writeFile(path.join(artifactDir!, name + ".png"), frame.elements[0]!.png);
              };
              try {
                stage = "browser pairing and public session creation";
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
                const sourcePaths = [
                  "src/agents/operator-run-recovery-source.ts",
                  "src/agents/command/session-preparation.ts",
                  "src/auto-reply/reply/restart-recovery-claim.ts",
                  "ui/src/e2e/peer-followup-restart.real-gateway.e2e.test.ts",
                  "dist/index.js",
                  "dist/.buildstamp",
                  "dist/.runtime-postbuildstamp",
                ];
                proof.sourceBinding = {
                  gitHead: (await promisify(execFile)("git", ["rev-parse", "HEAD"])).stdout.trim(),
                  files: await Promise.all(
                    sourcePaths.map(async (file) => ({
                      path: file,
                      sha256: sha256(await readFile(file)),
                    })),
                  ),
                  modelSha256: sha256(modelRef),
                };
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
                proof.uiAsset = { path: assetPath, sha256: sha256(assetBytes) };

                const effectCommand = "echo " + effect + " >> " + effectFile + "; echo " + effect;
                const safeCommand =
                  "node -e " +
                  JSON.stringify(
                    "fetch('" +
                      commandGate.url +
                      "').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }).then(console.log).catch(e => { console.error(e.message); process.exitCode = 1; })",
                  );
                const targetTask = [
                  "Perform this small task in order. First use exec exactly once for this command, wait for its successful result, and preserve that completed result:",
                  effectCommand,
                  "Then use a separate exec for this read-only HTTP command (timeout 180 seconds), waiting for its output:",
                  safeCommand,
                  "After the HTTP command succeeds, reply with exactly its response text. Do not call sessions_send or announce back to the source.",
                ].join("\n");
                const prompt =
                  "Use sessions_send once with sessionKey=" +
                  targetKey +
                  ", mode=followup, timeoutSeconds=0, and this exact message:\n" +
                  targetTask +
                  "\nAfter acceptance, reply only " +
                  delegated +
                  ". Do not run the commands yourself or wait for the peer.";
                const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
                stage = "UI operator sends delegation";
                await pane
                  .getByRole("textbox", { name: "Chat composer", exact: true })
                  .fill(prompt);
                await pane.getByRole("button", { name: "Send message", exact: true }).click();
                await withinTest(commandGate.blocked, signal);
                await expect
                  .poll(
                    async () => completedTool(await history(sourceKey), "sessions_send", targetKey),
                    { timeout: 30_000 },
                  )
                  .toBe(true);
                await expect
                  .poll(async () => hasAssistantText(await history(sourceKey), delegated), {
                    timeout: 30_000,
                  })
                  .toBe(true);
                proof.sourceHistory = await history(sourceKey);
                const beforeHistory = await history(targetKey);
                proof.targetHistoryBeforeAssertions = beforeHistory;
                stage = "verify completed target exec before crash";
                // Public history retains exitCode, not the private exec status field.
                expect(completedTool(beforeHistory, "exec", effect)).toBe(true);
                const completedEffect = messages(beforeHistory).find(
                  (message) =>
                    message.role === "toolResult" &&
                    message.toolName === "exec" &&
                    record(message.details)?.exitCode === 0 &&
                    JSON.stringify(message.content).includes(effect),
                );
                expect(completedEffect?.toolCallId).toEqual(expect.any(String));
                // The gate must belong to the target's actual second tool call, not
                // merely appear in the delegated prompt or an unrelated source command.
                expect(
                  messages(beforeHistory).some(
                    (message) =>
                      message.role === "assistant" &&
                      Array.isArray(message.content) &&
                      message.content.some((value) => {
                        const block = record(value);
                        const command = record(block?.arguments)?.command;
                        return (
                          block?.type === "toolCall" &&
                          block.name === "exec" &&
                          typeof command === "string" &&
                          command.includes(commandGate.url)
                        );
                      }),
                  ),
                ).toBe(true);
                expect(
                  await readFile(path.join(owner.state.workspaceDir, effectFile), "utf8"),
                ).toBe(effect + "\n");
                const before = (await rows()).find((row) => row.key === targetKey);
                expect(typeof before?.sessionId).toBe("string");
                expect(before?.sessionId?.length).toBeGreaterThan(0);
                proof.before = { target: before, history: beforeHistory };
                await page.goto(controlUiSessionUrl(suite.server.baseUrl, targetKey));
                await waitForControlUiGatewayReady(page);
                const thread = pane.locator(".chat-thread");
                await capture("01-before-crash", thread, [thread]);
                expect(commandGate.counts().requestsBeforeCrash).toBe(1);

                stage = "SIGKILL owned Gateway";
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
                proof.crash = {
                  pid: oldPid,
                  signal: child.signalCode,
                  stateDirectorySha256: sha256(owner.stateDir),
                };
                const sendCountAtCrash = sent.filter((item) => item.method === "chat.send").length;
                expect(sendCountAtCrash).toBe(1);
                stage = "restart same disk and await automatic continuation";
                await owner.startGateway();
                expect(owner.child?.pid).not.toBe(oldPid);
                proof.restart = {
                  pid: owner.child?.pid,
                  stateDirectorySha256: sha256(owner.stateDir),
                };
                // No refresh, new task, or recovery RPC: the existing tab reconnects itself.
                stage = "automatic browser reconnect";
                await waitForControlUiGatewayReady(page);
                stage = "resumed read-only request";
                await withinTest(commandGate.resumed, signal);
                stage = "final answer rendering";
                const answer = pane
                  .locator(".chat-group.assistant .chat-text")
                  .filter({ hasText: finalAnswer })
                  .last();
                await answer.waitFor({ state: "visible", timeout: 120_000 });
                await expect
                  .poll(
                    async () => {
                      const row = (await rows()).find((item) => item.key === targetKey);
                      return row?.status;
                    },
                    { timeout: 30_000 },
                  )
                  .toBe("done");
                const after = (await rows()).find((row) => row.key === targetKey);
                expect(after).toMatchObject({
                  sessionId: before!.sessionId,
                  status: "done",
                  hasActiveRun: false,
                });
                expect(after?.restartRecoveryStatus).toBeUndefined();
                expect(after?.lastRunError).toBeUndefined();
                expect(errors).toEqual([]);
                expect(sent.filter((item) => item.method === "chat.send")).toHaveLength(
                  sendCountAtCrash,
                );
                expect(sent.some((item) => item.method === "sessions.recover")).toBe(false);
                stage = "verify completed effect and final transcript";
                const afterHistory = await history(targetKey);
                proof.targetHistoryAfterAssertions = afterHistory;
                expect(hasAssistantText(afterHistory, finalAnswer)).toBe(true);
                const effects = messages(afterHistory).filter(
                  (message) =>
                    message.role === "toolResult" &&
                    message.toolName === "exec" &&
                    message.toolCallId === completedEffect!.toolCallId &&
                    record(message.details)?.exitCode === 0 &&
                    message.isError !== true &&
                    JSON.stringify(message.content).includes(effect),
                );
                expect(effects).toHaveLength(1);
                expect(
                  await readFile(path.join(owner.state.workspaceDir, effectFile), "utf8"),
                ).toBe(effect + "\n");
                // The group includes private tool/model metadata even when collapsed.
                // Capture only the real rendered answer; keep the privacy assertion intact.
                await capture("02-automatically-finished", answer, [answer]);
                proof.after = {
                  target: after,
                  history: afterHistory,
                  completedEffectResults: effects.length,
                  effectLines: 1,
                };
                proof.complete = true;
                stage = "complete";
              } catch (error) {
                proof.gatewayLog = sanitize(owner.logs());
                try {
                  const [sessions, targetHistory] = await withinTest(
                    Promise.all([rows(), history(targetKey)]),
                    signal,
                  );
                  proof.failureSessions = sessions;
                  proof.failureTargetHistory = targetHistory;
                } catch (snapshotError) {
                  proof.failureSnapshotError = sanitize(String(snapshotError));
                }
                proof.failure = sanitize(
                  error instanceof Error ? (error.stack ?? error.message) : String(error),
                );
                throw new Error(
                  "Peer restart live proof failed during " + stage + ": " + String(proof.failure),
                  { cause: error },
                );
              } finally {
                proof.browserRequests = sent;
                proof.targetErrors = errors;
                proof.gateCounts = commandGate.counts();
                await saveProof();
              }
            },
          );
        },
      });
      console.log("Peer restart browser proof: " + artifactDir);
    }, 300_000);
  });
}
