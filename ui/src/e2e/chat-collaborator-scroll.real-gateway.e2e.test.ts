import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord as record } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type {
  GatewayFrame,
  HelloOk,
} from "../../../packages/gateway-protocol/src/schema/frames.ts";
import { ensureProfileForEmail, setDisplayName } from "../../../src/state/user-profiles.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { ApplicationRuntime } from "../app/bootstrap.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import {
  startScrollInferenceFixture,
  startAssistantVisibilityProbe,
  watchExistingReply,
  startScrollProbe,
  readScrollProbe,
} from "./chat-collaborator-scroll.real-gateway.test-support.ts";
import {
  traceCollaboratorVisuals,
  traceCollaboratorPaints,
  markCollaboratorVisuals,
} from "./chat-collaborator-visual-trace.test-support.ts";
import { chatThreadDistanceFromBottom, waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:collaborator-scroll";
const people = [
  { name: "Reader One", email: "reader.one@example.test" },
  { name: "Writer Two", email: "writer.two@example.test" },
];
let instance: OpenClawTestInstance;
let provider: Awaited<ReturnType<typeof startScrollInferenceFixture>>;
const proxies: ViteDevServer[] = [];
const urls: string[] = [];
const profileIds: string[] = [];
let artifactDir: string;
const proof: Record<string, unknown> = {
  transport: "real WebSocket; passive frame observation only",
  inference: "credential-free loopback Responses fixture; NOT a live external provider",
  captures: "separate full browser views; no transcript/footer compositing",
};
const suite = createControlUiE2eSuite({
  name: "Real Gateway sender-local collaborator scroll",
  startServerBeforeBrowser: true,
  async startServer() {
    artifactDir = createControlUiE2eArtifactDir("collaborator-scroll-real-gateway");
    provider = await startScrollInferenceFixture();
    const close = async () => {
      await runQaGatewayFixture(
        async () => {},
        ...proxies.map((proxy) => () => proxy.close()),
        async () => {
          await instance?.cleanup();
          proof.gatewayStopped = !instance?.child;
        },
        () => provider.close(),
        async () => {
          proof.providerFailures = provider.failures;
          proof.providerRequests = provider.requests();
          await writeFile(
            path.join(artifactDir, "proof.json"),
            JSON.stringify(proof, null, 2) + "\n",
          );
        },
      );
    };
    try {
      instance = await createOpenClawTestInstance({
        name: "collaborator-scroll-real-gateway",
        env: { VITEST: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
        config: {
          gateway: {
            controlUi: { enabled: true },
            trustedProxies: ["127.0.0.1", "::1"],
            auth: {
              mode: "trusted-proxy",
              trustedProxy: {
                allowLoopback: true,
                allowUsers: people.map((person) => person.email),
                userHeader: "x-forwarded-user",
                requiredHeaders: ["x-forwarded-proto"],
                deviceAutoApprove: {
                  enabled: true,
                  scopes: ["operator.admin", "operator.read", "operator.write"],
                },
              },
            },
          },
          cron: { enabled: false },
          agents: {
            ownership: "explicit",
            defaults: {
              model: "scroll-fixture/echo",
              modelPolicy: { allow: ["scroll-fixture/*"] },
            },
            entries: { main: { identity: { name: "Scroll Fixture" } } },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "scroll-fixture": {
                api: "openai-responses",
                apiKey: "synthetic-fixture-key",
                baseUrl: "http://127.0.0.1:" + provider.port + "/v1",
                models: [{ id: "echo", name: "Scroll fixture" }],
              },
            },
          },
          messages: { queue: { mode: "followup", byChannel: { webchat: "followup" } } },
          plugins: { allow: [] },
        },
      });
      for (const [index, person] of people.entries()) {
        const profile = ensureProfileForEmail(person.email, { env: instance.env });
        setDisplayName(profile.id, person.name, { env: instance.env });
        profileIds.push(profile.id);
        const proxy = await createServer({
          configFile: false,
          envFile: false,
          root: instance.state.workspaceDir,
          appType: "custom",
          logLevel: "error",
          server: {
            host: "127.0.0.1",
            port: 0,
            proxy: {
              "/": {
                target: "http://127.0.0.1:" + instance.port,
                ws: true,
                headers: {
                  "x-forwarded-for": "192.0.2." + (10 + index),
                  "x-forwarded-proto": "http",
                  "x-forwarded-user": person.email,
                },
              },
            },
          },
        });
        proxies.push(proxy);
        await proxy.listen();
        const url = proxy.resolvedUrls?.local[0];
        if (!url) {
          throw new Error("Fixed-user loopback proxy did not expose a URL");
        }
        urls.push(url);
      }
      const config = JSON.parse(await readFile(instance.configPath, "utf8"));
      // The instance helper defaults to token auth; this fixture uses real proxy identities.
      delete config.gateway.auth.token;
      config.gateway.controlUi.allowedOrigins = urls.map((url) => new URL(url).origin);
      await instance.state.writeConfig(config);
      await instance.startGateway();
      return { baseUrl: urls[0]!, close };
    } catch (error) {
      return await runQaGatewayFixture(async (): Promise<never> => {
        throw error;
      }, close);
    }
  },
});

function observe(page: Page) {
  const sent: GatewayFrame[] = [];
  const received: GatewayFrame[] = [];
  let sockets = 0;
  page.on("websocket", (socket) => {
    sockets += 1;
    socket.on("framesent", (frame) => sent.push(JSON.parse(frame.payload.toString())));
    socket.on("framereceived", (frame) => received.push(JSON.parse(frame.payload.toString())));
  });
  const requests = (method: string) =>
    sent.filter((frame) => frame.type === "req" && frame.method === method);
  const response = (id: string) =>
    received.find((frame) => frame.type === "res" && frame.id === id);
  const history = () =>
    received.filter(
      (frame) =>
        frame.type === "res" &&
        frame.ok &&
        sent.some(
          (request) =>
            request.type === "req" &&
            request.id === frame.id &&
            ["chat.history", "chat.startup"].includes(request.method),
        ),
    );
  return { sent, received, requests, response, history, sockets: () => sockets };
}
type Observation = ReturnType<typeof observe>;
async function send(
  page: Page,
  observed: Observation,
  message: string,
  afterDraft?: () => Promise<void>,
) {
  await markCollaboratorVisuals(page, "send:" + message);
  const before = observed.requests("chat.send").length;
  const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
  await composer.fill(message);
  await afterDraft?.();
  await page.getByRole("button", { name: /^(Send|Queue) message$/ }).click();
  await expect.poll(() => observed.requests("chat.send").length).toBe(before + 1);
  const request = observed.requests("chat.send")[before]!;
  if (request.type !== "req") {
    throw new Error("Expected a send request");
  }
  expect(record(request.params)).toMatchObject({ sessionKey, message });
  await expect.poll(() => observed.response(request.id)).toMatchObject({ ok: true });
  const runId = record(request.params)?.idempotencyKey;
  if (typeof runId !== "string") {
    throw new Error("Missing actual send run identity");
  }
  return { request, runId };
}
async function identity(page: Page) {
  return page.evaluate(() => {
    const snapshot = document.querySelector<HTMLElement & { runtime?: ApplicationRuntime }>(
      "openclaw-app",
    )?.runtime?.context.gateway.snapshot;
    return {
      user: snapshot?.selfUser,
      connId: snapshot?.hello?.server?.connId,
      authMethod: snapshot?.hello?.auth?.method,
    };
  });
}
async function assertAlignment(page: Page, prompt: string, own: boolean) {
  const row = page.locator(".chat-group.user", { hasText: prompt });
  await row.waitFor();
  const geometry = await row.evaluate((element) => {
    const bubble = element.querySelector(".chat-bubble")!;
    const thread = element.closest(".chat-thread")!;
    const rect = bubble.getBoundingClientRect();
    const viewport = thread.getBoundingClientRect();
    return {
      peer: element.classList.contains("chat-group--peer"),
      alignment: getComputedStyle(element).justifyContent,
      left: rect.left - viewport.left,
      right: viewport.right - rect.right,
    };
  });
  expect.soft(geometry.peer, prompt).toBe(!own);
  expect.soft(geometry.alignment, prompt).toBe(own ? "end" : "start");
  expect
    .soft(own ? geometry.left - geometry.right : geometry.right - geometry.left, prompt)
    .toBeGreaterThan(0);
  return geometry;
}
function paragraphs(prefix: string, count = 14) {
  return (
    Array.from(
      { length: count },
      (_, index) =>
        prefix +
        " paragraph " +
        (index + 1) +
        ". " +
        "This genuine streamed fixture response provides a stable reading anchor while another authenticated person writes. ".repeat(
          2,
        ),
    ).join("\n\n") + "\n\n"
  );
}
function hasPending(observed: Observation, runId: string) {
  return observed
    .history()
    .some(
      (frame) =>
        frame.type === "res" &&
        (
          record(record(frame.payload)?.pendingInputs)?.items as
            | Array<{ runId?: string }>
            | undefined
        )?.some((item) => item.runId === runId),
    );
}
function persistedEvent(observed: Observation, runId: string) {
  return observed.received.find(
    (frame) =>
      frame.type === "event" &&
      frame.event === "session.message" &&
      record(record(record(frame.payload)?.message)?.["__openclaw"])?.idempotencyKey ===
        runId + ":user",
  );
}
async function wheel(page: Page, delta: number) {
  await page.locator(".chat-pane-cache__pane--active .chat-thread").hover();
  await page.mouse.wheel(0, delta);
  await waitForChatScrollIdle(page);
}

suite.define(() => {
  it("only follows local submissions, preserving remote-send anchors through queue, stream, and persistence", async (context) => {
    await suite.runScenario(context, {
      retainedState: () => instance.stateDir,
      run: async () => {
        const options = {
          locale: "en-US",
          serviceWorkers: "block" as const,
          viewport: { width: 1440, height: 900 },
          ...(process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
            ? { recordVideo: { dir: artifactDir, size: { width: 1440, height: 900 } } }
            : {}),
        };
        await suite.withPage(options, async ({ page: reader }) => {
          await suite.withPage(options, async ({ page: writer }) => {
            const pages = [reader, writer];
            const traceVisuals = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
            const finishVisuals = traceVisuals
              ? await Promise.all(
                  pages.map((page, index) =>
                    traceCollaboratorVisuals(page, artifactDir, index === 0 ? "reader" : "writer"),
                  ),
                )
              : [];
            const finishPaints = traceVisuals
              ? await traceCollaboratorPaints(reader, artifactDir)
              : null;
            const observers = pages.map(observe);
            const [a, b] = observers as [Observation, Observation];
            const capture = async (stage: string) => {
              for (const [index, page] of pages.entries()) {
                await page.screenshot({
                  path: path.join(
                    artifactDir,
                    stage + "-" + (index === 0 ? "ReaderOne" : "WriterTwo") + ".png",
                  ),
                });
              }
            };
            try {
              for (const [index, page] of pages.entries()) {
                await page.addInitScript(() =>
                  localStorage.setItem(
                    "openclaw:control-ui:community-invite",
                    JSON.stringify({ dismissedAtMs: 1770000000000 }),
                  ),
                );
                const documentResponse = await page.goto(
                  new URL("settings/profile", urls[index]!).href,
                );
                expect(
                  documentResponse?.status(),
                  "matching Gateway and UI build must serve the profile document",
                ).toBe(200);
                await waitForControlUiGatewayReady(page);
                if (index === 0) {
                  proof.session = await page.evaluate(async (key) => {
                    const client = document.querySelector<
                      HTMLElement & { runtime?: ApplicationRuntime }
                    >("openclaw-app")?.runtime?.context.gateway.snapshot.client;
                    if (!client) {
                      throw new Error("Authenticated reader client missing");
                    }
                    return await client.request("sessions.create", {
                      key,
                      agentId: "main",
                      label: "Sender-local scroll proof",
                      visibility: "shared",
                    });
                  }, sessionKey);
                }
                await page.goto(controlUiSessionUrl(urls[index]!, sessionKey));
                await waitForControlUiGatewayReady(page);
                await expect
                  .poll(() => page.locator("openclaw-app-sidebar").textContent())
                  .toContain(people[index]!.name);
              }
              const identities = await Promise.all(pages.map(identity));
              proof.identities = identities;
              const clientInstanceIds: string[] = [];
              for (const [index, observed] of observers.entries()) {
                expect(identities[index]).toMatchObject({
                  user: {
                    id: profileIds[index],
                    name: people[index]!.name,
                    identity: { type: "profile", id: profileIds[index] },
                  },
                  authMethod: "trusted-proxy",
                  connId: expect.any(String),
                });
                const connect = observed.requests("connect").at(-1);
                if (!connect || connect.type !== "req") {
                  throw new Error("No real connect request");
                }
                const reply = observed.response(connect.id);
                if (!reply || reply.type !== "res") {
                  throw new Error("No real hello response");
                }
                const hello = reply.payload as HelloOk;
                const instanceId = record(record(connect.params)?.client)?.instanceId;
                if (typeof instanceId !== "string") {
                  throw new Error("No browser instance identity");
                }
                clientInstanceIds.push(instanceId);
                expect(
                  hello.snapshot.presence.find((entry) => entry.instanceId === instanceId)?.user
                    ?.id,
                ).toBe(profileIds[index]);
              }
              proof.clientInstanceIds = clientInstanceIds;
              expect(new Set(clientInstanceIds).size).toBe(2);
              expect(identities[0]!.connId).not.toBe(identities[1]!.connId);
              expect(profileIds[0]).not.toBe(profileIds[1]);
              proof.servedScripts = await Promise.all(
                pages.map((page) =>
                  page
                    .locator("script[src]")
                    .evaluateAll((scripts) =>
                      scripts.map((script) => new URL((script as HTMLScriptElement).src).pathname),
                    ),
                ),
              );
              const finishVisibility = await Promise.all(pages.map(startAssistantVisibilityProbe));
              // Short actual turns qualify both reciprocal sender alignments before scroll assertions.
              const alignments: unknown[] = [];
              for (const [index, prompt] of [
                "Reader's own first message",
                "Writer's own first message",
              ].entries()) {
                const turn = provider.plan();
                const submitted = await send(pages[index]!, observers[index]!, prompt);
                await expect.poll(provider.requests).toBe(turn.index);
                await turn.append("Acknowledged genuine composer turn " + turn.index + ".");
                await turn.finish();
                for (const [viewer, page] of pages.entries()) {
                  await expect
                    .poll(() => persistedEvent(observers[viewer]!, submitted.runId))
                    .toBeDefined();
                  alignments.push({
                    viewer: people[viewer]!.name,
                    prompt,
                    geometry: await assertAlignment(page, prompt, viewer === index),
                  });
                  await page
                    .getByRole("button", { name: "Stop generating", exact: true })
                    .waitFor({ state: "detached" });
                }
              }
              proof.alignments = alignments;
              console.info("REAL_GATEWAY_IDENTITIES", JSON.stringify({ identities, alignments }));
              await capture("01-reciprocal-identities");
              const scenarios: unknown[] = [];
              proof.scenarios = scenarios;
              for (const [mode, awaitTyping] of [
                ["reading", false],
                ["tail", false],
                ["reading-typed", true],
                ["tail-typed", true],
              ] as const) {
                const turn = provider.plan();
                const own = await send(reader, a, "Reader starts the " + mode + " scenario");
                await expect.poll(provider.requests).toBe(turn.index);
                await turn.append(paragraphs(mode));
                await expect
                  .poll(() =>
                    a.received.some(
                      (frame) =>
                        frame.type === "event" &&
                        frame.event === "chat" &&
                        record(frame.payload)?.sessionKey === sessionKey &&
                        record(frame.payload)?.state === "delta" &&
                        JSON.stringify(frame.payload).includes(mode + " paragraph 14."),
                    ),
                  )
                  .toBe(true);
                await waitForChatScrollIdle(reader);
                await expect
                  .poll(() => chatThreadDistanceFromBottom(reader))
                  .toBeLessThanOrEqual(8);
                if (mode.startsWith("reading")) {
                  await wheel(reader, -420);
                }
                await markCollaboratorVisuals(reader, mode + ":before-remote");
                const before = await startScrollProbe(reader);
                expect(
                  mode.startsWith("reading") ? before.distance > 8 : before.distance <= 8,
                ).toBe(true);
                await capture("02-" + mode + "-before-remote");
                const finishWriterPresence = await watchExistingReply(
                  writer,
                  mode + " paragraph 1.",
                );
                const remotePrompt = "Writer follow-up while Reader is at " + mode;
                const remote = await send(
                  writer,
                  b,
                  remotePrompt,
                  awaitTyping
                    ? async () => {
                        // Observe real remote typing before submission instead of racing
                        // the presence packet against its queued-custody replacement.
                        await expect
                          .poll(() =>
                            reader
                              .locator('.chat-virtual-row[data-virtual-row-key="presence:typing"]')
                              .textContent(),
                          )
                          .toContain(remotePrompt);
                      }
                    : undefined,
                );
                await expect.poll(() => hasPending(a, remote.runId)).toBe(true);
                const checkpoints: unknown[] = [];
                const checkpoint = async (stage: string) => {
                  await markCollaboratorVisuals(reader, mode + ":" + stage);
                  await waitForChatScrollIdle(reader);
                  const samples = await readScrollProbe(reader);
                  const latest = samples.at(-1)!;
                  checkpoints.push({ stage, ...latest });
                  console.info(
                    "REAL_GATEWAY_SCROLL",
                    JSON.stringify({
                      mode,
                      stage,
                      beforeTop: before.top,
                      beforeAnchor: before.anchor,
                      current: latest,
                    }),
                  );
                  expect
                    .soft(
                      Math.abs((latest.anchor ?? Infinity) - before.anchor!),
                      mode + ": " + stage + " anchor",
                    )
                    .toBeLessThanOrEqual(1);
                  expect
                    .soft(Math.abs(latest.top - before.top), mode + ": " + stage + " scrollTop")
                    .toBeLessThanOrEqual(1);
                };
                await checkpoint("real-pending-input");
                await turn.append(paragraphs(mode + " continuing", 3));
                await expect
                  .poll(() =>
                    a.received.some(
                      (frame) =>
                        frame.type === "event" &&
                        frame.event === "chat" &&
                        record(frame.payload)?.state === "delta" &&
                        JSON.stringify(frame.payload).includes(mode + " continuing paragraph 3."),
                    ),
                  )
                  .toBe(true);
                await checkpoint("assistant-stream-growth");
                const followup = provider.plan();
                await markCollaboratorVisuals(reader, mode + ":finish-active");
                await turn.finish();
                await expect.poll(provider.requests).toBe(followup.index);
                await expect.poll(() => persistedEvent(a, remote.runId)).toBeDefined();
                await checkpoint("pending-to-persisted");
                await followup.append("Writer follow-up completed in " + mode + ".");
                await followup.finish();
                for (const page of pages) {
                  await page
                    .getByRole("button", { name: "Stop generating", exact: true })
                    .waitFor({ state: "detached" });
                }
                await checkpoint("settled-history");
                const writerMissingFrames = await finishWriterPresence();
                expect
                  .soft(
                    writerMissingFrames,
                    mode + ": queued sender keeps the active reply present",
                  )
                  .toEqual([]);
                const samples = await readScrollProbe(reader, true);
                let largestStep = 1;
                for (let i = 2; i < samples.length; i += 1) {
                  if (
                    Math.abs(samples[i]!.top - samples[i - 1]!.top) >
                    Math.abs(samples[largestStep]!.top - samples[largestStep - 1]!.top)
                  ) {
                    largestStep = i;
                  }
                }
                console.info(
                  "REAL_GATEWAY_TRANSITION",
                  JSON.stringify({ mode, frames: samples.slice(largestStep - 1, largestStep + 2) }),
                );
                const maxDrift = Math.max(
                  ...samples.map((sample) =>
                    Math.abs((sample.anchor ?? Infinity) - before.anchor!),
                  ),
                );
                scenarios.push({
                  mode,
                  ownRunId: own.runId,
                  remoteRunId: remote.runId,
                  remoteAck: b.response(remote.request.id),
                  writerMissingFrames,
                  before,
                  checkpoints,
                  samples,
                  maxDrift,
                });
                expect
                  .soft(maxDrift, mode + ": every animation frame retains the reading anchor")
                  .toBeLessThanOrEqual(1);
                await capture("03-" + mode + "-after-remote");
                // A deliberate local submission from real wheel scrollback must resume follow.
                await wheel(reader, -420);
                expect(await chatThreadDistanceFromBottom(reader)).toBeGreaterThan(8);
                const local = provider.plan();
                await send(reader, a, "Reader deliberately resumes after " + mode);
                await expect
                  .poll(() => chatThreadDistanceFromBottom(reader))
                  .toBeLessThanOrEqual(8);
                await expect.poll(provider.requests).toBe(local.index);
                await local.append(paragraphs("local-resume-" + mode, 3));
                await waitForChatScrollIdle(reader);
                expect
                  .soft(
                    await chatThreadDistanceFromBottom(reader),
                    "local submit follows its assistant stream",
                  )
                  .toBeLessThanOrEqual(8);
                await local.finish();
                for (const page of pages) {
                  await page
                    .getByRole("button", { name: "Stop generating", exact: true })
                    .waitFor({ state: "detached" });
                }
                await capture("04-" + mode + "-local-resumed");
              }
              const visibilityFailures = await Promise.all(
                finishVisibility.map((finish) => finish()),
              );
              proof.assistantVisibilityFailures = visibilityFailures;
              expect
                .soft(
                  visibilityFailures,
                  "assistant text must not disappear or translate during arrival and handoff",
                )
                .toEqual([[], []]);
              expect(provider.failures).toEqual([]);
              for (const observed of observers) {
                // Profile bootstrap and the chat navigation each own a real connection.
                expect(observed.sockets()).toBe(2);
              }
            } finally {
              await finishPaints?.();
              for (const finish of finishVisuals) {
                await finish();
              }
              proof.protocol = observers.map((observed) => ({
                sockets: observed.sockets(),
                sends: observed
                  .requests("chat.send")
                  .map((frame) => (frame.type === "req" ? frame.params : null)),
                historyResponses: observed.history().length,
                events: observed.received
                  .filter((frame) => frame.type === "event")
                  .map((frame) => ({ event: frame.event, payload: frame.payload })),
              }));
              await writeFile(
                path.join(artifactDir, "proof.json"),
                JSON.stringify(proof, null, 2) + "\n",
              );
              await writeFile(path.join(artifactDir, "gateway.log"), instance.logs());
            }
          });
        });
      },
    });
  }, 240_000);
});
