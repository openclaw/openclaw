import { readFile } from "node:fs/promises";
import { asOptionalRecord as record } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type { GatewayFrame } from "../../../packages/gateway-protocol/src/schema/frames.ts";
import { setDisplayName } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import {
  startScrollInferenceFixture,
  startAssistantVisibilityProbe,
  watchExistingReply,
  startScrollProbe,
  readScrollProbe,
} from "./chat-collaborator-scroll.real-gateway.test-support.ts";
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
const suite = createControlUiE2eSuite({
  name: "Real Gateway collaborator scroll",
  startServerBeforeBrowser: true,
  async startServer() {
    provider = await startScrollInferenceFixture();
    const close = async () => {
      await runQaGatewayFixture(
        async () => {},
        ...proxies.map((proxy) => () => proxy.close()),
        () => instance?.cleanup(),
        () => provider.close(),
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
  page.on("websocket", (socket) => {
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
  return { received, requests, response, history };
}
type Observation = ReturnType<typeof observe>;
async function send(
  page: Page,
  observed: Observation,
  message: string,
  afterDraft?: () => Promise<void>,
) {
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
  await expect.poll(() => observed.response(request.id)).toBeDefined();
  const response = observed.response(request.id);
  expect(response, JSON.stringify(response)).toMatchObject({ ok: true });
  const runId = record(request.params)?.idempotencyKey;
  if (typeof runId !== "string") {
    throw new Error("Missing actual send run identity");
  }
  return { runId };
}
async function identity(page: Page) {
  return evaluateControlUiContext(page, (application) => {
    const snapshot = application.gateway.snapshot;
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
  expect.soft(geometry, prompt).toMatchObject({ peer: !own, alignment: own ? "end" : "start" });
  expect
    .soft(own ? geometry.left - geometry.right : geometry.right - geometry.left, prompt)
    .toBeGreaterThan(0);
}
function paragraphs(prefix: string, count = 14) {
  const body =
    "This genuine streamed fixture response provides a stable reading anchor while another authenticated person writes. ";
  return (
    Array.from(
      { length: count },
      (_, index) => `${prefix} paragraph ${index + 1}. ${body.repeat(2)}`,
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
async function waitForDelta(observed: Observation, text: string, expectedSession?: string) {
  await expect
    .poll(() =>
      observed.received.some(
        (frame) =>
          frame.type === "event" &&
          frame.event === "chat" &&
          (expectedSession === undefined ||
            record(frame.payload)?.sessionKey === expectedSession) &&
          record(frame.payload)?.state === "delta" &&
          JSON.stringify(frame.payload).includes(text),
      ),
    )
    .toBe(true);
}
async function waitForSettlement(page: Page) {
  await page
    .getByRole("button", { name: "Stop generating", exact: true })
    .waitFor({ state: "detached" });
}
async function wheel(page: Page, delta: number) {
  await page.locator(".chat-pane-cache__pane--active .chat-thread").hover();
  await page.mouse.wheel(0, delta);
  await waitForChatScrollIdle(page);
}

suite.define(() => {
  it("preserves reader intent through remote queue, stream, and persistence", async (context) => {
    await suite.runScenario(context, {
      retainedState: () => instance.stateDir,
      run: async () => {
        const options = {
          locale: "en-US",
          serviceWorkers: "block" as const,
          viewport: { width: 1440, height: 900 },
        };
        await suite.withPage(options, async ({ page: reader }) => {
          await suite.withPage(options, async ({ page: writer }) => {
            const pages = [reader, writer];
            const observers = pages.map(observe);
            const [a, b] = observers as [Observation, Observation];
            for (const [index, page] of pages.entries()) {
              await page.addInitScript(() =>
                localStorage.setItem(
                  "openclaw:control-ui:community-invite:v2",
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
                await evaluateControlUiContext(
                  page,
                  async (application, key) => {
                    const client = application.gateway.snapshot.client;
                    if (!client) {
                      throw new Error("Authenticated reader client missing");
                    }
                    return await client.request("sessions.create", {
                      key,
                      agentId: "main",
                      label: "Sender-local scroll proof",
                      visibility: "shared",
                    });
                  },
                  sessionKey,
                );
              }
              await page.goto(controlUiSessionUrl(urls[index]!, sessionKey));
              await waitForControlUiGatewayReady(page);
              await expect
                .poll(() => page.locator("openclaw-app-sidebar").textContent())
                .toContain(people[index]!.name);
            }
            const identities = await Promise.all(pages.map(identity));
            for (const index of [0, 1]) {
              expect(identities[index]).toMatchObject({
                user: {
                  id: profileIds[index],
                  name: people[index]!.name,
                  identity: { type: "profile", id: profileIds[index] },
                },
                authMethod: "trusted-proxy",
                connId: expect.any(String),
              });
            }
            expect(identities[0]!.connId).not.toBe(identities[1]!.connId);
            expect(profileIds[0]).not.toBe(profileIds[1]);
            const finishVisibility = await Promise.all(pages.map(startAssistantVisibilityProbe));
            // Short actual turns qualify both reciprocal sender alignments before scroll assertions.
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
                await assertAlignment(page, prompt, viewer === index);
                await waitForSettlement(page);
              }
            }
            for (const [mode, awaitTyping] of [
              ["reading", false],
              ["tail", false],
              ["reading-typed", true],
              ["tail-typed", true],
              ["older-history", false],
              ["near-bottom", false],
            ] as const) {
              const reading = !mode.startsWith("tail");
              const turn = provider.plan();
              await send(reader, a, "Reader starts the " + mode + " scenario");
              await expect.poll(provider.requests).toBe(turn.index);
              await turn.append(paragraphs(mode));
              await waitForDelta(a, mode + " paragraph 14.", sessionKey);
              await waitForChatScrollIdle(reader);
              await expect.poll(() => chatThreadDistanceFromBottom(reader)).toBeLessThanOrEqual(8);
              if (reading) {
                const delta =
                  mode === "near-bottom"
                    ? -80
                    : mode === "older-history"
                      ? -(await reader
                          .locator('.chat-virtual-row[data-virtual-row-key^="agent-run:"]')
                          .last()
                          .evaluate((element) => element.getBoundingClientRect().height)) - 350
                      : -420;
                await wheel(reader, delta);
              }
              const before = await startScrollProbe(reader);
              expect(reading ? before.distance > 8 : before.distance <= 8).toBe(true);
              if (mode === "older-history") {
                expect(before.anchorText).not.toContain(mode + " paragraph");
              }
              const readerSends = a.requests("chat.send").length;
              const finishWriterPresence = await watchExistingReply(writer, mode + " paragraph 1.");
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
              const checkpoint = async (stage: string) => {
                await waitForChatScrollIdle(reader);
                const samples = await readScrollProbe(reader);
                const latest = samples.at(-1)!;
                expect(new Set(latest.keys).size, stage).toBe(latest.keys.length);
                expect(a.requests("chat.send"), stage).toHaveLength(readerSends);
                if (reading) {
                  expect
                    .soft(
                      Math.abs((latest.anchor ?? Infinity) - before.anchor!),
                      mode + ": " + stage + " anchor",
                    )
                    .toBeLessThanOrEqual(1);
                  // Persistence can regroup rows above the reader. The visible
                  // anchor and follow lock must survive that offset correction.
                  expect
                    .soft(latest.policy?.locked, mode + ": " + stage + " follow lock")
                    .toBe(true);
                } else {
                  // A geometry pause can precede the history publication triggered by persistence.
                  await expect
                    .poll(() => chatThreadDistanceFromBottom(reader), {
                      message: mode + ": " + stage + " follows",
                    })
                    .toBeLessThanOrEqual(8);
                }
              };
              await checkpoint("real-pending-input");
              await turn.append(paragraphs(mode + " continuing", 3));
              await waitForDelta(a, mode + " continuing paragraph 3.");
              await checkpoint("assistant-stream-growth");
              const followup = provider.plan();
              await turn.finish();
              await expect.poll(provider.requests).toBe(followup.index);
              await expect.poll(() => persistedEvent(a, remote.runId)).toBeDefined();
              await checkpoint("pending-to-persisted");
              await followup.append("Writer follow-up completed in " + mode + ".");
              await followup.finish();
              for (const page of pages) {
                await waitForSettlement(page);
              }
              await checkpoint("settled-history");
              const writerMissingFrames = await finishWriterPresence();
              expect
                .soft(writerMissingFrames, mode + ": queued sender keeps the active reply present")
                .toEqual([]);
              const samples = await readScrollProbe(reader, true);
              const maxDrift = Math.max(
                ...samples.map((sample) => Math.abs((sample.anchor ?? Infinity) - before.anchor!)),
              );
              if (reading) {
                expect
                  .soft(maxDrift, mode + ": every animation frame retains the reading anchor")
                  .toBeLessThanOrEqual(1);
              }
              // A deliberate local submission from real wheel scrollback must resume follow.
              await wheel(reader, -420);
              expect(await chatThreadDistanceFromBottom(reader)).toBeGreaterThan(8);
              const local = provider.plan();
              await send(reader, a, "Reader deliberately resumes after " + mode);
              await expect.poll(() => chatThreadDistanceFromBottom(reader)).toBeLessThanOrEqual(8);
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
                await waitForSettlement(page);
              }
            }
            const visibilityFailures = await Promise.all(
              finishVisibility.map((finish) => finish()),
            );
            expect
              .soft(
                visibilityFailures,
                "assistant text must not disappear or translate during arrival and handoff",
              )
              .toEqual([[], []]);
            expect(provider.failures).toEqual([]);
          });
        });
      },
    });
  }, 240_000);
});
