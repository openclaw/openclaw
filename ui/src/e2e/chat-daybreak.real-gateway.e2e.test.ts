// Real built UI, Gateway persistence, queue admission and OpenAI plugin; only external I/O is synthetic.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { zstdDecompressSync } from "node:zlib";
import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
import type { ModelCatalogResult, SessionsListResult } from "../api/types.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { connectChatGateway } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let owner: OpenClawTestInstance;
let client: Awaited<ReturnType<typeof connectChatGateway>>;
const call = <T = unknown>(method: string, params: Record<string, unknown>) =>
  client.request<T>(method, params);
let dir: string;
let programs: string[] | undefined = ["standard", "daybreak_blue", "daybreak_red"];
let reasoningEfforts = ["medium"];
const receipts: Array<{ model: string; access?: unknown; tier?: string; credential: string }> = [];
let preparationGate: ServerResponse | undefined;
const unentitledKey = "sk-synthetic-unentitled-fixture";
const held = new Map<number, ServerResponse>();
let holdNext = false;
let inferenceRequests = 0;
const proof: Record<string, unknown> = {
  externalIO: "synthetic authenticated catalog and Responses fixture",
  productionEntitlement: false,
  complete: false,
};
const reply = (response: ServerResponse, index: number) =>
  writeOpenAiResponsesText(response, {
    text: "Fixture reply " + index,
    responseId: "response-" + index,
    messageId: "message-" + index,
  });
const suite = createControlUiE2eSuite({
  name: "Daybreak through a real built Gateway",
  startServerBeforeBrowser: true,
  resources: {
    async run(signal) {
      client = await connectChatGateway(owner, signal);
    },
    async close() {
      await client?.stopAndWait();
    },
  },
  async startServer() {
    dir = createControlUiE2eArtifactDir("daybreak-real-gateway");
    const provider = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          void (async () => {
            const url = new URL(request.url ?? "/", "http://fixture");
            if (url.pathname === "/fixture/preparation-gate") {
              request.resume();
              preparationGate = response;
              return;
            }
            const advertised =
              request.headers.authorization === "Bearer " + unentitledKey ? [] : programs;
            if (url.pathname === "/v1/models") {
              response.setHeader("content-type", "application/json");
              response.end(JSON.stringify({ data: [{ id: "gpt-6.1-sol", object: "model" }] }));
              return;
            }
            if (url.pathname.endsWith("/models")) {
              response.setHeader("content-type", "application/json");
              response.end(
                JSON.stringify({
                  models: [
                    {
                      slug: "gpt-6.1-sol",
                      display_name: "GPT-6.1 Sol",
                      visibility: "list",
                      context_window: 128000,
                      max_output_tokens: 16000,
                      supported_reasoning_levels: reasoningEfforts.map((effort) => ({
                        effort,
                        description: effort,
                      })),
                      service_tiers: [{ id: "priority" }, { id: "ultrafast" }],
                      ...(advertised ? { available_access_programs: { cyber: advertised } } : {}),
                    },
                  ],
                }),
              );
              return;
            }
            if (request.method === "POST" && url.pathname.endsWith("/responses")) {
              inferenceRequests += 1;
              const wire = await buffer(request);
              const body = JSON.parse(
                (request.headers["content-encoding"] === "zstd"
                  ? zstdDecompressSync(wire)
                  : wire
                ).toString(),
              );
              if (body.model !== "gpt-6.1-sol") {
                proof.auxiliaryRequests = [
                  ...(Array.isArray(proof.auxiliaryRequests) ? proof.auxiliaryRequests : []),
                  { model: body.model, keys: Object.keys(body) },
                ];
                reply(response, -1);
                return;
              }
              const index = receipts.length;
              receipts.push({
                model: body.model,
                access: body.access_programs,
                tier: body.service_tier,
                credential:
                  request.headers.authorization === "Bearer sk-synthetic-configured-fixture"
                    ? "configured"
                    : request.headers.authorization === "Bearer " + unentitledKey
                      ? "unentitled"
                      : request.headers.authorization === "Bearer sk-synthetic-platform-fixture"
                        ? "saved-profile"
                        : "subscription",
              });
              if (holdNext) {
                holdNext = false;
                held.set(index, response);
              } else {
                reply(response, index);
              }
              return;
            }
            request.resume();
            response.writeHead(404).end();
          })().catch((error: unknown) => {
            proof.fixtureFailure = String(error);
            response.destroy();
          });
        }),
    });
    const preload = path.join(dir, "provider-network-fixture.cjs");
    await writeFile(
      preload,
      `const undici = require(${JSON.stringify(createRequire(import.meta.url).resolve("undici/index.js"))});
// Keep fetch and its dispatcher on the same Undici version.
const original = undici.fetch;
const localDispatcher = new undici.Agent();
globalThis.fetch = (input, init) => { const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); if (url.hostname === "chatgpt.com" || url.hostname === "api.openai.com") { const local = "http://127.0.0.1:PORT" + url.pathname + url.search; const { dispatcher, ...localInit } = init ?? {}; return original(typeof input === "string" || input instanceof URL ? local : new Request(local, input), { ...localInit, dispatcher: localDispatcher }); } if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return original(input, { ...init, dispatcher: localDispatcher }); throw new Error("External network forbidden in Daybreak fixture: " + url.hostname); };
// Cover native dispatcher fetch as well as global fetch; no provider I/O leaves the fixture.
globalThis.fetch.mock = {};
globalThis.__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__ = { ...undici, fetch: globalThis.fetch };
`.replace("PORT", String(provider.claim.port)),
    );
    const gatePlugin = path.join(dir, "preparation-gate");
    await mkdir(gatePlugin);
    await writeFile(
      path.join(gatePlugin, "openclaw.plugin.json"),
      JSON.stringify({
        id: "daybreak-proof-gate",
        activation: { onStartup: true },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    await writeFile(
      path.join(gatePlugin, "package.json"),
      JSON.stringify({
        name: "daybreak-proof-gate",
        version: "0.0.0",
        type: "module",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    await writeFile(
      path.join(gatePlugin, "index.js"),
      `export default { id: "daybreak-proof-gate", register(api) {
      api.on("before_agent_run", async (event) => {
        if (event.prompt.includes("DAYBREAK_REPLACEMENT_BARRIER")) {
          const response = await fetch(${JSON.stringify("http://127.0.0.1:" + provider.claim.port + "/fixture/preparation-gate")}, {method:"POST"});
          if (!response.ok) throw new Error("Preparation barrier failed");
          await response.text();
        }
      });
    } };`,
    );
    owner = await createOpenClawTestInstance({
      name: "daybreak-real-gateway",
      entrypoint: ["dist/index.js"],
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        VITEST: undefined,
        NODE_OPTIONS: (process.env.NODE_OPTIONS ?? "") + " --require=" + preload,
      },
      config: {
        update: { checkOnStart: false },
        auth: {
          profiles: {
            "openai:daybreak-fixture": { provider: "openai", mode: "oauth" },
            "openai:platform-fixture": { provider: "openai", mode: "api_key" },
          },
          order: { openai: ["openai:daybreak-fixture"] },
        },
        gateway: { controlUi: { enabled: true } },
        cron: { enabled: false },
        memory: { search: { enabled: false } },
        agents: {
          defaults: {
            model: "openai/gpt-6.1-sol",
            models: {
              "openai/gpt-6.1-sol": {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", responsesServerCompaction: false },
              },
            },
          },
        },
        plugins: {
          allow: ["openai", "daybreak-proof-gate"],
          load: { paths: [gatePlugin] },
          entries: {
            codex: { enabled: false },
            "daybreak-proof-gate": { enabled: true, hooks: { allowConversationAccess: true } },
          },
        },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-responses",
              auth: "api-key",
              apiKey: "sk-synthetic-configured-fixture",
              models: [],
            },
          },
        },
      },
    });
    const token =
      "e30." +
      Buffer.from(
        JSON.stringify({
          exp: Math.floor(Date.now() / 1000) + 86400,
          "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-daybreak-account" },
        }),
      ).toString("base64url") +
      ".synthetic";
    await owner.state.writeAuthProfiles({
      version: 1,
      profiles: {
        "openai:platform-fixture": {
          type: "api_key",
          provider: "openai",
          key: "sk-synthetic-platform-fixture",
        },
        "openai:daybreak-fixture": {
          type: "oauth",
          provider: "openai",
          access: token,
          refresh: "synthetic-refresh",
          expires: Date.now() + 86400000,
          accountId: "synthetic-daybreak-account",
        },
      },
    });
    const close = async () => {
      try {
        await writeFile(path.join(dir, "gateway.private.log"), owner.logs());
        await owner.cleanup();
      } finally {
        preparationGate?.destroy();
        preparationGate = undefined;
        for (const response of held.values()) {
          response.destroy();
        }
        provider.listener.closeAllConnections();
        await provider.releaseListener();
        await provider.claim.release();
        await writeFile(
          path.join(dir, "proof.json"),
          JSON.stringify({ ...proof, receipts, cleanupReturned: true }, null, 2),
        );
      }
    };
    try {
      await owner.startGateway();
      return { baseUrl: "http://127.0.0.1:" + owner.port + "/", close };
    } catch (error) {
      proof.startupFailure = String(error);
      await close();
      throw error;
    }
  },
});

suite.define(() => {
  it("discovers configured-key programs in the UI and submits the selected access", async () => {
    const runCli = async (args: string[]) => {
      const result = await owner.cli(args);
      expect(result.code, result.stderr).toBe(0);
      return result.stdout;
    };
    const key = "agent:main:platform-discovery";
    await call("sessions.create", { key, agentId: "main", label: "Platform discovery" });
    const inferenceCount = inferenceRequests;
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
        await pairControlUiPage(page, runCli);
        for (const advertised of [
          undefined,
          [],
          ["standard", "daybreak_blue"],
          ["standard", "daybreak_red"],
        ]) {
          programs = advertised;
          const result = await call<ModelCatalogResult>("models.list", {
            agentId: "main",
            sessionKey: key,
            view: "configured",
            refresh: true,
          });
          expect(result.providerOutcomes).toContainEqual(
            expect.objectContaining({
              provider: "openai",
              status: "ready",
            }),
          );
          expect(
            result.models.find((model: { id: string }) => model.id === "gpt-6.1-sol")
              ?.availableAccessPrograms?.cyber,
          ).toEqual(advertised);
          if (advertised === undefined) {
            await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
            await waitForControlUiGatewayReady(page);
          }
          const picker = page.locator(".chat-controls__effort-picker").first();
          await expect
            .poll(() => picker.locator("summary").getAttribute("aria-disabled"))
            .toBe("false");
          if (!(await picker.locator(".chat-controls__effort-menu").isVisible())) {
            await picker.locator("summary").click();
          }
          await picker.locator(".chat-controls__effort-menu").waitFor();
          await expect
            .poll(() =>
              picker
                .locator("[data-chat-access-option]")
                .evaluateAll((nodes) =>
                  nodes.map((node) => node.getAttribute("data-chat-access-option")),
                ),
            )
            .toEqual(advertised ?? []);
          expect(inferenceRequests).toBe(inferenceCount);
          const frame = await takeControlUiScreenshotFrame(
            page,
            picker.locator(".chat-controls__effort-menu"),
            [],
            { animations: "disabled" },
          );
          await writeFile(
            path.join(dir, "configured-key-" + (advertised?.at(-1) ?? "unknown") + ".png"),
            frame.png,
          );
        }
        const picker = page.locator(".chat-controls__effort-picker").first();
        await picker.locator('[data-chat-access-option="daybreak_red"]').click();
        await expect
          .poll(async () => {
            const result = await call<SessionsListResult>("sessions.list", { agentId: "main" });
            return result.sessions.find((session) => session.key === key)?.cyberAccessProgram;
          })
          .toBe("daybreak_red");
        const index = receipts.length;
        await evaluateControlUiContext(
          page,
          async (context, data) =>
            context.gateway.snapshot.client!.request("chat.send", {
              sessionKey: data.key,
              message: "Reply with the fixture result.",
              idempotencyKey: data.id,
            }),
          { key, id: randomUUID() },
        );
        await expect.poll(() => receipts.length).toBe(index + 1);
        expect(receipts[index]?.access).toEqual({ cyber: "daybreak_red" });
        await expect
          .poll(async () => {
            const result = await call<SessionsListResult>("sessions.list", { agentId: "main" });
            return Boolean(result.sessions.find((session) => session.key === key)?.hasActiveRun);
          })
          .toBe(false);
      },
    );
    proof.platformDiscovery = {
      complete: true,
      discoveryInferenceRequests: 0,
      selectedAccessRequests: 1,
    };
  }, 90_000);

  it("rejects foreign grants and credential replacement before final Responses dispatch", async () => {
    programs = ["standard", "daybreak_blue"];
    const configureKey = async (apiKey: string) => {
      const config = await call<{ hash: string }>("config.get", {});
      await call("config.patch", {
        baseHash: config.hash,
        raw: JSON.stringify({ models: { providers: { openai: { apiKey } } } }),
        response: "summary",
      });
      await call("models.list", { agentId: "main", provider: "openai", refresh: true });
    };
    const catalog = async (key: string) =>
      (
        await call<ModelCatalogResult>("models.list", {
          sessionKey: key,
          view: "configured",
          provider: "openai",
          refresh: true,
        })
      ).models.find((model) => model.id === "gpt-6.1-sol")?.availableAccessPrograms?.cyber;
    const create = async (key: string) => {
      await call("sessions.create", { key, agentId: "main", label: key });
      await call("sessions.patch", { key, cyberAccessProgram: "daybreak_blue" });
    };
    await configureKey("sk-synthetic-configured-fixture");
    const control = "agent:main:dispatch-control";
    await create(control);
    const donor = "agent:main:dispatch-donor";
    await call("sessions.create", {
      key: donor,
      agentId: "main",
      label: "Independent saved account",
    });
    await call("sessions.patch", {
      key: donor,
      model: "openai/gpt-6.1-sol@openai:platform-fixture",
    });
    const runCli = async (args: string[]) => {
      const result = await owner.cli(args);
      expect(result.code, result.stderr).toBe(0);
      return result.stdout;
    };
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await pairControlUiPage(page, runCli);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, control));
      await waitForControlUiGatewayReady(page);
      const send = (key: string, message: string) =>
        evaluateControlUiContext(
          page,
          async (context, data) =>
            context.gateway.snapshot.client!.request<{ runId: string }>("chat.send", {
              sessionKey: data.key,
              message: data.message,
              idempotencyKey: data.id,
            }),
          { key, message, id: randomUUID() },
        );
      const wait = (runId: string) =>
        call<{ status: string; error?: string }>("agent.wait", { runId, timeoutMs: 10_000 });
      const initialRequests = receipts.length;
      const positive = await send(control, "Daybreak dispatch positive control.");
      expect((await wait(positive.runId)).status).toBe("ok");
      expect(receipts.slice(initialRequests)).toEqual([
        expect.objectContaining({ credential: "configured", access: { cyber: "daybreak_blue" } }),
      ]);
      const trace = [];
      for (const phase of ["before-admission", "during-preparation"] as const) {
        await configureKey("sk-synthetic-configured-fixture");
        const key = "agent:main:dispatch-" + phase;
        await create(key);
        expect(await catalog(key)).toEqual(["standard", "daybreak_blue"]);
        const before = receipts.length;
        let runId: string;
        if (phase === "during-preparation") {
          preparationGate = undefined;
          runId = (await send(key, "DAYBREAK_REPLACEMENT_BARRIER")).runId;
          await expect.poll(() => Boolean(preparationGate)).toBe(true);
          expect(receipts).toHaveLength(before);
        }
        await configureKey(unentitledKey);
        const selectedPrograms = await catalog(key);
        const foreignPrograms = await catalog(donor);
        expect(selectedPrograms).toEqual([]);
        expect(foreignPrograms).toEqual(["standard", "daybreak_blue"]);
        if (phase === "during-preparation") {
          preparationGate!.end("released");
          preparationGate = undefined;
        } else {
          runId = (await send(key, "Reject the unentitled configured credential.")).runId;
        }
        const terminal = await wait(runId!);
        expect(["ok", "error"]).toContain(terminal.status);
        const history = await call("chat.history", { sessionKey: key, limit: 20 });
        // Replacement retires the prepared runtime before transport; a fresh run reaches Access.
        const rejection =
          phase === "during-preparation"
            ? "prepared model runtime publication was superseded"
            : "not advertised for the current account";
        expect(JSON.stringify({ terminal, history })).toContain(rejection);
        expect(receipts).toHaveLength(before);
        trace.push({
          phase,
          selectedPrograms,
          foreignPrograms,
          terminal: terminal.status,
          rejection,
          preparationBarrierObserved: phase === "during-preparation",
          outboundResponsesRequests: receipts.length - before,
        });
      }
      proof.directCredentialAuthority = { complete: true, positiveRequests: 1, cases: trace };
    });
  }, 90_000);

  it("persists visible selections and refreshes queued requests on desktop and mobile", async () => {
    // The subscription scenario owns its original route, independently of the configured-key case.
    const config = await call<{ hash: string }>("config.get", {});
    await call("config.patch", {
      baseHash: config.hash,
      raw: JSON.stringify({ models: { providers: { openai: null } } }),
      replacePaths: ["models.providers.openai.models"],
      response: "summary",
    });
    const runCli = async (args: string[]) => {
      const result = await owner.cli(args);
      expect(result.code, result.stderr).toBe(0);
      return result.stdout;
    };
    for (const mobile of [false, true]) {
      const name = mobile ? "mobile" : "desktop";
      const key = "agent:main:daybreak-" + name;
      programs = ["standard", "daybreak_blue", "daybreak_red"];
      reasoningEfforts = ["medium"];
      proof.initialCatalog = await call("models.list", { agentId: "main", refresh: true });
      expect(proof.initialCatalog).toMatchObject({
        providerOutcomes: expect.arrayContaining([
          expect.objectContaining({ profileId: "openai:daybreak-fixture", status: "ready" }),
        ]),
      });
      await call("sessions.create", { key, agentId: "main", label: "Daybreak " + name });
      await suite.withPage(
        {
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
          colorScheme: "dark",
        },
        async ({ page }) => {
          await pairControlUiPage(page, runCli);
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
          await waitForControlUiGatewayReady(page);
          const picker = page.locator(".chat-controls__effort-picker").first();
          const menu = picker.locator(".chat-controls__effort-menu");
          const select = picker.locator("[data-chat-access-program]");
          const open = async () => {
            // The mobile toolbar is revealed by the real composer focus interaction.
            if (mobile && !(await picker.locator("summary").isVisible())) {
              await page.locator(".agent-chat__input textarea").click();
            }
            await expect
              .poll(() => picker.locator("summary").getAttribute("aria-disabled"))
              .toBe("false");
            if (!(await menu.isVisible())) {
              await picker.locator("summary").click();
            }
            await menu.waitFor();
          };
          const snapshot = async (stage: string) => {
            const frame = await takeControlUiScreenshotFrame(page, menu, [], {
              animations: "disabled",
            });
            await writeFile(path.join(dir, name + "-" + stage + ".png"), frame.png);
          };
          const row = async () => {
            const result = await call<SessionsListResult>("sessions.list", {
              agentId: "main",
              limit: 100,
            });
            return result.sessions.find((entry) => entry.key === key)!;
          };
          const choose = async (value: string) => {
            await open();
            if (value) {
              await select.locator(`[data-chat-access-option="${value}"]`).click();
            } else {
              await picker.locator("[data-chat-access-default]").click();
            }
            await expect
              .poll(async () => (await row()).cyberAccessProgram)
              .toBe(value || undefined);
          };
          const send = async (text: string) =>
            evaluateControlUiContext(
              page,
              async (context, data) =>
                context.gateway.snapshot.client!.request("chat.send", {
                  sessionKey: data.key,
                  message: data.text,
                  queueMode: "followup",
                  idempotencyKey: data.id,
                }),
              { key, text, id: randomUUID() },
            );
          await open();
          await expect.poll(() => select.count()).toBe(1);
          expect(
            await select
              .locator("[data-chat-access-option]")
              .evaluateAll((nodes) =>
                nodes.map((node) => node.getAttribute("data-chat-access-option")),
              ),
          ).toEqual(["standard", "daybreak_blue", "daybreak_red"]);
          const script = await page
            .locator('script[type="module"][src]')
            .first()
            .getAttribute("src");
          const bytes = await (
            await page.request.get(new URL(script!, suite.server.baseUrl).href)
          ).body();
          expect(bytes.equals(await readFile(path.join("dist/control-ui", script!.slice(1))))).toBe(
            true,
          );
          proof.uiAsset = {
            path: script,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
          const slider = picker.locator("[data-chat-thinking-slider]");
          await expect.poll(() => slider.inputValue()).toBe("0");
          expect(await slider.getAttribute("data-chat-thinking-values")).toBe("medium,ultra");
          expect(await slider.getAttribute("data-effort-boost")).toBe("");
          expect(
            await slider.evaluate(
              (input) => getComputedStyle(input.parentElement!).backgroundImage,
            ),
          ).toBe("none");
          proof[name + "-narrowed-effort"] = await slider.evaluate((input: HTMLInputElement) => ({
            values: input.dataset.chatThinkingValues,
            value: input.value,
            fill: input.style.getPropertyValue("--reasoning-fill"),
            boost: input.dataset.effortBoost,
          }));
          await snapshot("both");
          const red = select.locator('[data-chat-access-option="daybreak_red"]');
          await red.focus();
          await red.press("Home");
          await expect.poll(async () => (await row()).cyberAccessProgram).toBe("standard");
          await select.locator('[data-chat-access-option="standard"]').press("ArrowRight");
          await expect.poll(async () => (await row()).cyberAccessProgram).toBe("daybreak_blue");
          await choose("");
          for (const target of ["standard", ""]) {
            await choose("daybreak_blue");
            const first = receipts.length;
            holdNext = true;
            await send("Hold this fixture turn.");
            await expect.poll(() => held.has(first)).toBe(true);
            expect(receipts[first]?.access).toEqual({ cyber: "daybreak_blue" });
            await send("Use the preference saved before this queued turn starts.");
            proof.persistedDuringRun = (await row()).cyberAccessProgram;
            proof.afterSendCatalog = await call("models.list", {
              agentId: "main",
              sessionKey: key,
            });
            await choose(target);
            expect(receipts).toHaveLength(first + 1);
            const response = held.get(first)!;
            held.delete(first);
            reply(response, first);
            await expect.poll(() => receipts.length).toBe(first + 2);
            expect(receipts[first + 1]?.access).toEqual(target ? { cyber: target } : undefined);
            await expect.poll(async () => Boolean((await row()).hasActiveRun)).toBe(false);
            proof[name + "-queued-" + (target || "cleared")] = receipts.slice(first, first + 2);
          }
          reasoningEfforts = ["low", "medium", "high"];
          await call("models.list", { agentId: "main", refresh: true });
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await open();
          await expect
            .poll(() => slider.getAttribute("data-chat-thinking-values"))
            .toBe("low,medium,high,ultra");
          await slider.press("Home");
          await expect.poll(async () => (await row()).thinkingLevel).toBe("low");
          await slider.press("ArrowRight");
          await expect.poll(async () => (await row()).thinkingLevel).toBe("medium");
          await expect.poll(() => slider.inputValue()).toBe("1");
          expect(await slider.getAttribute("data-effort-boost")).toBe("");
          await snapshot("multilevel-medium");
          const bounds = await slider.boundingBox();
          expect(bounds).not.toBeNull();
          await slider.click({ position: { x: (bounds!.width * 2) / 3, y: bounds!.height / 2 } });
          await expect.poll(async () => (await row()).thinkingLevel).toBe("high");
          await slider.press("End");
          await expect.poll(async () => (await row()).thinkingLevel).toBe("ultra");
          await expect.poll(() => slider.inputValue()).toBe("3");
          expect(await slider.getAttribute("data-effort-boost")).toBe("ultra");
          await call("sessions.patch", { key, thinkingLevel: "medium" });
          reasoningEfforts = ["medium"];
          await choose("daybreak_blue");
          programs = ["standard", "daybreak_blue"];
          await call("models.list", { agentId: "main", refresh: true });
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await open();
          await expect
            .poll(() => select.locator('[data-chat-access-option="daybreak_red"]').count())
            .toBe(0);
          await snapshot("blue-only");
          programs = [];
          await call("models.list", { agentId: "main", refresh: true });
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await open();
          await expect.poll(() => select.count()).toBe(0);
          expect((await row()).cyberAccessProgram).toBe("daybreak_blue");
          await snapshot("no-access");
          programs = undefined;
          await call("models.list", { agentId: "main", refresh: true });
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await open();
          expect(await select.count()).toBe(0);
          await snapshot("unknown");
          await picker.locator("summary").click();
          const modelPicker = page.locator(".chat-controls__model-picker").first();
          await modelPicker.locator("summary").click();
          const recovery = modelPicker.getByRole("button", { name: "Clear saved Access" });
          await recovery.waitFor();
          const stale = await takeControlUiScreenshotFrame(
            page,
            modelPicker.locator(".chat-controls__model-menu"),
            [],
            { animations: "disabled" },
          );
          await writeFile(path.join(dir, name + "-stale-selection.png"), stale.png);
          await recovery.click();
          await expect.poll(async () => (await row()).cyberAccessProgram).toBeUndefined();
          await expect.poll(() => recovery.count()).toBe(0);
          const before = receipts.length;
          await send("Continue after clearing stale Access.");
          await expect.poll(() => receipts.length).toBe(before + 1);
          expect(receipts[before]?.access).toBeUndefined();
          await expect.poll(async () => Boolean((await row()).hasActiveRun)).toBe(false);
        },
      );
    }
    proof.complete = true;
  }, 180_000);
});
