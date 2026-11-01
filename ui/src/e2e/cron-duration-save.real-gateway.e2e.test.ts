import { withTimeout } from "@openclaw/fs-safe/advanced";
// Browser edits persist through the normal built Gateway with independent readback.
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewayClient } from "../../../src/gateway/client.ts";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { createRequireRecord } from "../../../test/helpers/record.js";
import type { CronJob } from "../api/types.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  recordControlUiE2eFailureFacts,
} from "../test-helpers/control-ui-e2e-diagnostics.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installControlUiE2eRendererStallProbe } from "../test-helpers/control-ui-e2e-renderer-stall.ts";
import { openPicker, pickerValue, selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

async function startGateway(owner: OpenClawTestInstance, prepare?: () => Promise<unknown>) {
  try {
    await prepare?.();
    await owner.startGateway();
    return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
  } catch (error) {
    await runQaGatewayFixture(
      async () => {
        throw error;
      },
      () => owner.cleanup(),
    );
    throw error;
  }
}

let instance: OpenClawTestInstance | undefined;
let seedClient: GatewayClient | undefined;
const suite = createControlUiE2eSuite({
  name: "Control UI exact stagger with a real Gateway",
  startServerBeforeBrowser: true,
  resources: {
    async run(signal) {
      if (!instance) {
        throw new Error("Gateway fixture was not started");
      }
      seedClient = await acquireGatewayTestClient(
        {
          url: instance.url,
          token: instance.gatewayToken,
          env: instance.env,
          clientName: "cli",
          mode: "cli",
          scopes: ["operator.admin"],
          deviceIdentity: null,
          deviceAuthScope: instance.url,
          sharedStateMode: "read-only",
          requestTimeoutMs: 10_000,
        },
        {
          signal,
          timeoutMs: 10_000,
          timeoutMessage: "Automation seed client did not connect",
          closeMessage: "Automation seed client closed during connect",
        },
      );
      await withGatewayCommands(async (cliJson) => {
        expect(await cliJson(["automations", "status", "--json"])).toMatchObject({
          enabled: false,
        });
      });
    },
    async close() {
      await seedClient?.stopAndWait();
    },
  },
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-exact-stagger",
      config: {
        gateway: { controlUi: { enabled: true } },
        agents: { defaults: { model: "openai/gpt-4.1" } },
        cron: {
          enabled: false,
          failureAlert: {
            enabled: true,
            after: 5,
            cooldownMs: 7301,
            mode: "webhook",
            to: "https://alerts.example.test/global",
            includeSkipped: false,
          },
        },
      },
    });
    instance = owner;
    return startGateway(owner, () =>
      owner.state.writeAuthProfiles({
        version: 1,
        profiles: {
          "openai:cron-duration-fixture": {
            type: "api_key",
            provider: "openai",
            key: "synthetic-cron-duration-inference-key",
          },
        },
      }),
    );
  },
});

let catalogInstance: OpenClawTestInstance | undefined;
const catalogModels = (id: string) => [
  { id: "anchor", name: "Anchor" },
  { id, name: id },
];
const catalogSuite = createControlUiE2eSuite({
  name: "Automation catalog publication with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "automation-catalog-publication",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: {
        gateway: { controlUi: { enabled: true } },
        plugins: { enabled: false },
        cron: { enabled: false },
        agents: { defaults: { model: "fixture/anchor" } },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              apiKey: "synthetic-catalog-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: catalogModels("retiring"),
            },
          },
        },
      },
    });
    catalogInstance = owner;
    return startGateway(owner);
  },
});

catalogSuite.define(() => {
  it("keeps an open automation draft current after real catalog publication and read recovery", async () => {
    const owner = catalogInstance;
    if (!owner) {
      throw new Error("Catalog Gateway fixture was not started");
    }
    const handoff = await owner.cli(["dashboard", "--json"]);
    expect(handoff.code).toBe(0);
    const browserUrl = requireRecord(JSON.parse(handoff.stdout)).browserUrl;
    if (typeof browserUrl !== "string") {
      throw new Error("Dashboard did not return a browser handoff");
    }
    const url = new URL("cron", browserUrl);
    url.hash = new URL(browserUrl).hash;
    const catalogRequests = new Set<string>();
    const catalogTrace: string[] = [];
    const traceCatalog = (event: string) => {
      catalogTrace.push(event);
      if (catalogTrace.length > 24) {
        catalogTrace.shift();
      }
    };
    let rejectCatalogReplies = false;
    const rejected = new Set<string>();
    let catalogDrained: (() => void) | undefined;
    let awaitCatalogPublication = false;
    const pendingNotifications: Array<() => void> = [];
    type PublicationPhase = "published" | "held" | "recovered";
    const publish = async (id: PublicationPhase) => {
      if (catalogRequests.size) {
        await new Promise<void>((resolve) => {
          catalogDrained = resolve;
        });
      }
      awaitCatalogPublication = true;
      const args = [
        "config",
        "set",
        "models.providers.fixture.models",
        JSON.stringify(catalogModels(id)),
        "--strict-json",
        "--replace",
      ];
      const result = await owner.cli(args);
      expect(result.code, result.stderr).toBe(0);
    };
    await catalogSuite.withPage(
      {
        ...createControlUiE2eContextOptions(),
      },
      async ({ page }) => {
        await page.routeWebSocket(`ws://127.0.0.1:${owner.port}/**`, (socket) => {
          const server = socket.connectToServer();
          socket.onMessage((message) => {
            const frame = requireRecord(JSON.parse(message.toString()));
            if (frame.type === "req" && frame.method !== "connect") {
              if (frame.method === "models.list" && typeof frame.id === "string") {
                catalogRequests.add(frame.id);
                traceCatalog("catalog-request");
              }
            }
            server.send(message);
          });
          server.onMessage((message) => {
            const frame = requireRecord(JSON.parse(message.toString()));
            const catalogReply = typeof frame.id === "string" && catalogRequests.has(frame.id);
            const catalogChange =
              frame.event === "config.changed" || frame.event === "chat.metadata.changed";
            if (catalogReply && typeof frame.id === "string") {
              traceCatalog(frame.ok ? "catalog-reply-ok" : "catalog-reply-error");
              catalogRequests.delete(frame.id);
              if (!catalogRequests.size) {
                catalogDrained?.();
              }
            }
            // Exercise reads after real publication, not config changes during an in-flight read.
            // Keep the Gateway's notifications intact and in their original order.
            if (awaitCatalogPublication && catalogChange) {
              traceCatalog(
                frame.event === "config.changed" ? "config-changed-held" : "metadata-changed-held",
              );
              pendingNotifications.push(() => socket.send(message));
              if (
                frame.event === "chat.metadata.changed" &&
                requireRecord(frame.payload).modelCatalogChanged === true
              ) {
                awaitCatalogPublication = false;
                traceCatalog("catalog-publication-released");
                for (const send of pendingNotifications.splice(0)) {
                  send();
                }
              }
              return;
            }
            // Inject failure after observing the real reply. Notifications and recovery
            // still come from the Gateway; no synthetic catalog or event replaces them.
            if (catalogReply && rejectCatalogReplies && typeof frame.id === "string") {
              traceCatalog("catalog-reply-rejected");
              rejected.add(frame.id);
              socket.send(
                JSON.stringify({
                  type: "res",
                  id: frame.id,
                  ok: false,
                  error: { code: "UNAVAILABLE", message: "Catalog transport unavailable" },
                }),
              );
            } else {
              socket.send(message);
            }
          });
        });
        await page.goto(url.toString());
        await waitForControlUiGatewayReady(page);
        await page.locator('[data-test-id="cron-new-task"]').click();
        await page.locator("#cron-name").fill("Retain this draft");
        await page.locator("#cron-payload-text").fill("Do not submit this draft");
        const picker = page.locator("openclaw-select-picker:has(#cron-payload-model-picker)");
        const modelOption = (id: string) =>
          picker.locator(`[role="option"][data-value="fixture/${id}"]`);
        const waitForModel = async (id: string) => {
          try {
            await expect
              .poll(async () => {
                await openPicker(picker);
                return modelOption(id).count();
              })
              .toBe(1);
          } catch (error) {
            recordControlUiE2eFailureFacts(page, {
              expectedModel: id,
              catalogTrace: [...catalogTrace],
              catalogRequestsInFlight: catalogRequests.size,
              rejectedCatalogReplies: rejected.size,
              awaitingCatalogPublication: awaitCatalogPublication,
              heldCatalogNotifications: pendingNotifications.length,
            });
            await withTimeout(
              page.evaluate(() => {
                const pickerElement = document.querySelector(
                  "openclaw-select-picker:has(#cron-payload-model-picker)",
                );
                const values = Array.from(
                  pickerElement?.querySelectorAll('[role="option"]') ?? [],
                ).map((option) => option.getAttribute("data-value"));
                return {
                  catalogPickerPresent: Boolean(pickerElement),
                  catalogPickerExpanded:
                    pickerElement
                      ?.querySelector(".picker-select__trigger")
                      ?.getAttribute("aria-expanded") ?? null,
                  catalogOptionCount: values.length,
                  catalogFixtureOptions: [
                    "anchor",
                    "retiring",
                    "published",
                    "held",
                    "recovered",
                  ].filter((modelId) => values.includes(`fixture/${modelId}`)),
                  catalogDraftNameRetained:
                    document.querySelector<HTMLInputElement>("#cron-name")?.value ===
                    "Retain this draft",
                  catalogDraftPayloadRetained:
                    document.querySelector<HTMLTextAreaElement>("#cron-payload-text")?.value ===
                    "Do not submit this draft",
                };
              }),
              500,
            )
              .then((facts) =>
                recordControlUiE2eFailureFacts(page, { ...facts, catalogDomRead: true }),
              )
              .catch(() => recordControlUiE2eFailureFacts(page, { catalogDomRead: false }));
            throw error;
          }
        };
        await waitForModel("retiring");
        await publish("published");
        await waitForModel("published");
        expect(await modelOption("retiring").count()).toBe(0);

        rejectCatalogReplies = true;
        await publish("held");
        await expect.poll(() => rejected.size).toBeGreaterThan(0);
        const error = page.locator(".cron-error-banner");
        await error.waitFor({ state: "visible" });
        expect(await error.textContent()).toContain("Catalog transport unavailable");
        await waitForModel("published");

        rejectCatalogReplies = false;
        await publish("recovered");
        await waitForModel("recovered");
        await error.waitFor({ state: "hidden" });
        expect(await page.locator("#cron-name").inputValue()).toBe("Retain this draft");
        expect(await page.locator("#cron-payload-text").inputValue()).toBe(
          "Do not submit this draft",
        );
      },
    );
  }, 120_000);
});

const requireRecord = createRequireRecord("record", "expected-object-value");
type CliJson = (args: string[]) => Promise<Record<string, unknown>>;
type CronPageEvidence = {
  page: Page;
  requests: Record<string, unknown>[];
  replies: Record<string, unknown>[];
};

async function withGatewayCommands(run: (cliJson: CliJson) => Promise<void>) {
  if (!instance) {
    throw new Error("Gateway fixture was not started");
  }
  const owner = instance;
  const redact = (text: string) =>
    text
      .replaceAll(owner.gatewayToken, "[synthetic token]")
      .replaceAll(owner.hookToken, "[synthetic token]");
  const cliJson: CliJson = async (args) => {
    const result = await owner.cli(["--no-color", ...args]);
    expect(result.code, `${args.join(" ")}\n${redact(result.stderr)}`).toBe(0);
    expect(result.signal).toBeNull();
    return requireRecord(JSON.parse(result.stdout));
  };
  await run(cliJson);
}

function cronJobId(result: Record<string, unknown>): string {
  const job = "job" in result ? requireRecord(result.job) : result;
  if (typeof job.id !== "string") {
    throw new Error("Gateway did not return a job id");
  }
  return job.id;
}

let cronPage: CronPageEvidence | undefined;

async function withCronJobPage(
  cliJson: CliJson,
  jobId: string,
  run: (evidence: CronPageEvidence) => Promise<void>,
) {
  const firstVisit = !cronPage;
  if (!cronPage) {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    await installControlUiE2eRendererStallProbe(page);
    const requests: Record<string, unknown>[] = [];
    const replies: Record<string, unknown>[] = [];
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        const frame = requireRecord(JSON.parse(payload.toString()));
        if (
          frame.type === "req" &&
          (frame.method === "cron.update" || frame.method === "cron.add")
        ) {
          requests.push(frame);
        }
      });
      socket.on("framereceived", ({ payload }) => {
        const frame = requireRecord(JSON.parse(payload.toString()));
        if (frame.type === "res" && requests.some(({ id }) => id === frame.id)) {
          replies.push(frame);
        }
      });
    });
    cronPage = { page, requests, replies };
  }
  const evidence = cronPage;
  const { page, requests, replies } = evidence;
  requests.length = 0;
  replies.length = 0;
  try {
    if (firstVisit) {
      const handoff = await cliJson(["dashboard", "--json"]);
      expect(handoff.ok).toBe(true);
      if (typeof handoff.browserUrl !== "string") {
        throw new Error("Dashboard did not return its normal browser handoff");
      }
      const issued = new URL(handoff.browserUrl);
      const url = new URL("cron", issued);
      url.hash = issued.hash;
      url.searchParams.set("job", jobId);
      const document = await page.goto(url.toString());
      if (!document) {
        throw new Error("Gateway did not return the Control UI document");
      }
      expect(document.status()).toBe(200);
    } else {
      // Retire the previous editor and its open disclosures through normal routing.
      await evaluateControlUiContext(page, (app) => app.navigate("about"));
      await page.locator("openclaw-about-page").waitFor();
      await page.locator("openclaw-cron-page").waitFor({ state: "detached" });
      await evaluateControlUiContext(
        page,
        (app, id) => app.navigate("cron", { search: `?job=${encodeURIComponent(id)}`, hash: "" }),
        jobId,
      );
      await page.locator("openclaw-cron-page").waitFor();
    }
    await waitForControlUiGatewayReady(page);
    expect(new URL(page.url()).hash.length).toBe(0);
    await run(evidence);
  } catch (error) {
    await captureControlUiE2eFailureDiagnostics(page, {
      error: error instanceof Error ? error : new Error(String(error)),
      label: "Control UI exact stagger with a real Gateway",
    });
    throw error;
  }
}

async function submitCronForm(
  evidence: CronPageEvidence,
  method: "cron.add" | "cron.update",
  readJob = readStoredJob,
) {
  const { page, requests, replies } = evidence;
  const previousRequests = requests.length;
  await page.locator('[data-test-id="cron-submit"]').click();
  await expect.poll(() => requests.length).toBe(previousRequests + 1);
  const request = requireRecord(requests[previousRequests]);
  expect(request.method).toBe(method);
  await expect.poll(() => replies.some(({ id }) => id === request.id)).toBe(true);
  const reply = requireRecord(replies.find(({ id }) => id === request.id));
  expect(reply).toMatchObject({ ok: true });
  const id = cronJobId(requireRecord(method === "cron.add" ? reply.payload : request.params));
  if (method === "cron.add") {
    await page.locator('.cron-page[data-panel-mode="overview"]').waitFor();
    await page.locator(`[data-test-id="cron-row-${id}"]`).waitFor();
  } else {
    await expect.poll(() => page.locator('[data-test-id="cron-submit"]').isDisabled()).toBe(false);
  }
  const stored = await readJob(id);
  expect(stored).toMatchObject({ id, enabled: false });
  return { request, reply, stored };
}

async function readStoredJob(id: string) {
  if (!seedClient) {
    throw new Error("Automation seed client was not started");
  }
  return requireRecord(await seedClient.request("cron.get", { id }));
}

async function seedAlertJob(name: string, failureAlert: CronJob["failureAlert"]) {
  const result = await seedPausedAgentJob(
    name,
    {
      kind: "agentTurn",
      message: "Synthetic paused failure-alert fixture",
    },
    { failureAlert },
  );
  const id = cronJobId(result);
  const stored = await readStoredJob(id);
  expect(stored).toMatchObject({
    id,
    name,
    enabled: false,
    schedule: { kind: "every", everyMs: 60_000 },
  });
  expect(stored.failureAlert).toEqual(failureAlert);
  return { id, stored };
}

function seedCliAutomation(cliJson: CliJson, name: string, flags: Record<string, string | true>) {
  const options: typeof flags = { name, agent: "main", disabled: true, ...flags, json: true };
  return cliJson([
    "automations",
    "add",
    ...Object.entries(options).flatMap(([key, value]) =>
      value === true ? [`--${key}`] : [`--${key}`, value],
    ),
  ]);
}

async function seedPausedAgentJob(
  name: string,
  payload: CronJob["payload"],
  overrides: Pick<CronJob, "failureAlert"> = {},
) {
  if (!seedClient) {
    throw new Error("Automation seed client was not started");
  }
  return requireRecord(
    await seedClient.request("cron.add", {
      name,
      agentId: "main",
      enabled: false,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload,
      delivery: { mode: "none" },
      ...overrides,
    }),
  );
}

async function choosePicker(picker: Locator, value: string) {
  await selectPickerValue(picker, value);
  await expect.poll(() => pickerValue(picker)).toBe(value);
}

async function readAlertFields(page: Page) {
  const mode = page.locator("openclaw-select-picker:has(#cron-failure-alert-delivery-mode)");
  return {
    after: await page.locator("#cron-failure-alert-after").inputValue(),
    cooldown: await page.locator("#cron-failure-alert-cooldown-seconds").inputValue(),
    mode: await pickerValue(mode),
    modeLabel: await mode.locator(".picker-select__trigger .picker-select__label").textContent(),
  };
}

async function openAdvanced(page: Page, name: unknown) {
  await expect.poll(() => page.locator(".cron-detail-title").textContent()).toBe(name);
  await page.locator("details.cron-advanced > summary").click();
}

suite.define(() => {
  it("timeout override: clearing restores the default after save and reload", async () => {
    await withGatewayCommands(async (cliJson) => {
      const job = await seedCliAutomation(cliJson, "Clear timeout override", {
        session: "isolated",
        message: "Synthetic paused timeout fixture",
        every: "2h",
        "timeout-seconds": "90",
        "no-deliver": true,
      });
      const jobId = cronJobId(job);
      await withCronJobPage(cliJson, jobId, async (evidence) => {
        const { page } = evidence;
        await page.locator("details.cron-advanced > summary").click();
        const timeout = page.locator("#cron-timeout-seconds");
        expect(await timeout.inputValue()).toBe("90");
        await timeout.fill("");
        const cleared = await submitCronForm(evidence, "cron.update");
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await page.locator("details.cron-advanced > summary").click();
        await timeout.scrollIntoViewIfNeeded();
        expect(cleared.stored.payload).not.toHaveProperty("timeoutSeconds");
        expect(await timeout.inputValue()).toBe("");
        for (const value of ["0", "0.25"]) {
          await timeout.fill(value);
          const saved = await submitCronForm(evidence, "cron.update");
          expect(saved.stored.payload).toMatchObject({ timeoutSeconds: Number(value) });
          expect(await timeout.inputValue()).toBe(value);
        }
      });
    });
  });

  it("configured duration precision: saves stagger through the real Gateway and CLI readback", async () => {
    await withGatewayCommands(async (cliJson) => {
      const job = await seedCliAutomation(cliJson, "Browser stagger fixture", {
        session: "main",
        "system-event": "Synthetic paused browser fixture",
        cron: "0 * * * *",
        tz: "UTC",
        stagger: "1001ms",
      });
      expect(job).toMatchObject({ enabled: false, schedule: { staggerMs: 1_001 } });
      const jobId = cronJobId(job);
      await withCronJobPage(cliJson, jobId, async (evidence) => {
        const { page } = evidence;
        await openAdvanced(page, job.name);
        const amount = page.locator("#cron-stagger-amount");
        const loadedStagger = await amount.inputValue();
        await amount.scrollIntoViewIfNeeded();
        await page.locator("#cron-cron-expr").fill("*/5 * * * *");
        const { request, stored } = await submitCronForm(evidence, "cron.update", (id) =>
          cliJson(["automations", "get", id, "--json"]),
        );
        const reloadedStagger = await amount.inputValue();
        await amount.scrollIntoViewIfNeeded();
        expect({ loadedStagger, submitted: request.params, stored, reloadedStagger }).toMatchObject(
          {
            loadedStagger: "1.001",
            submitted: {
              id: jobId,
              expectedConfigRevision: job.configRevision,
              patch: {
                enabled: false,
                schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC", staggerMs: 1_001 },
              },
            },
            stored: {
              id: jobId,
              enabled: false,
              schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC", staggerMs: 1_001 },
            },
            reloadedStagger: "1.001",
          },
        );
      });
    });
  });

  it("failure alert round trip: preserves partial policy through metadata save and clone", async () => {
    await withGatewayCommands(async (cliJson) => {
      const policy = { cooldownMs: 1_001, includeSkipped: true };
      const job = await seedAlertJob("Partial failure policy", policy);
      await withCronJobPage(cliJson, job.id, async (evidence) => {
        const { page } = evidence;
        await openAdvanced(page, job.stored.name);
        const loaded = await readAlertFields(page);
        await page.locator("#cron-failure-alert-cooldown-seconds").scrollIntoViewIfNeeded();
        await page.locator("#cron-description").fill("Only metadata changed");
        const saved = await submitCronForm(evidence, "cron.update");
        const savedFields = await readAlertFields(page);
        const menu = page.locator(".cron-detail-actions .cron-job-menu");
        await menu.locator(".cron-job-menu__trigger").click();
        await menu.locator('[data-value="clone"]').click();
        await page.locator("#cron-name").fill("Cloned partial failure policy");
        const cloned = await submitCronForm(evidence, "cron.add");
        const cloneId = cronJobId(cloned.stored);
        await page.locator(`[data-test-id="cron-row-${cloneId}"]`).click();
        await openAdvanced(page, cloned.stored.name);
        const clonedFields = await readAlertFields(page);
        await page.locator("#cron-failure-alert-cooldown-seconds").scrollIntoViewIfNeeded();
        const expectedFields = {
          after: "",
          cooldown: "1.001",
          mode: "",
          modeLabel: "Inherit global setting",
        };
        expect({ loaded, savedFields, clonedFields }).toEqual({
          loaded: expectedFields,
          savedFields: expectedFields,
          clonedFields: expectedFields,
        });
        expect([saved.stored.failureAlert, cloned.stored.failureAlert]).toEqual([policy, policy]);
        expect([saved.stored.schedule, cloned.stored.schedule]).toEqual([
          job.stored.schedule,
          job.stored.schedule,
        ]);
      });
    });
  });

  it("failure alert round trip: clears field overrides through the real picker", async () => {
    await withGatewayCommands(async (cliJson) => {
      const job = await seedAlertJob("Clear failure policy", {
        after: 4,
        cooldownMs: 1_001,
        mode: "webhook",
        to: "https://alerts.example.test/job",
        accountId: "fixture-account",
        includeSkipped: true,
      });
      await withCronJobPage(cliJson, job.id, async (evidence) => {
        const { page } = evidence;
        await openAdvanced(page, job.stored.name);
        await page.locator("#cron-failure-alert-after").fill("");
        await page.locator("#cron-failure-alert-cooldown-seconds").fill("");
        const deliveryMode = page.locator(
          "openclaw-select-picker:has(#cron-failure-alert-delivery-mode)",
        );
        await deliveryMode.locator(".picker-select__trigger").click();
        const inheritOption = deliveryMode.locator('[role="option"][data-value=""]');
        await inheritOption.waitFor({ state: "visible" });
        expect(await inheritOption.textContent()).toContain("Inherit global setting");
        await inheritOption.click();
        await expect.poll(() => pickerValue(deliveryMode)).toBe("");
        await expect
          .poll(() =>
            deliveryMode.locator(".picker-select__trigger .picker-select__label").textContent(),
          )
          .toBe("Inherit global setting");
        const cleared = await submitCronForm(evidence, "cron.update");
        expect(cleared.request.params).toMatchObject({
          patch: { failureAlert: { after: null, cooldownMs: null, mode: null } },
        });
        expect(cleared.stored.failureAlert).toEqual({
          to: "https://alerts.example.test/job",
          accountId: "fixture-account",
          includeSkipped: true,
        });
        const policyMode = page.locator("openclaw-select-picker:has(#cron-failure-alert-mode)");
        await choosePicker(policyMode, "inherit");
        const inherited = await submitCronForm(evidence, "cron.update");
        expect(inherited.request.params).toMatchObject({ patch: { failureAlert: null } });
        expect(inherited.stored).not.toHaveProperty("failureAlert");
        await choosePicker(policyMode, "disabled");
        const disabled = await submitCronForm(evidence, "cron.update");
        expect(disabled.stored.failureAlert).toBe(false);
        await choosePicker(policyMode, "custom");
        await page.locator("#cron-failure-alert-cooldown-seconds").fill("0");
        const zero = await submitCronForm(evidence, "cron.update");
        expect(zero.stored.failureAlert).toEqual({ cooldownMs: 0 });
      });
    });
  });

  it("clone payload policy: preserves public options through the real Gateway and CLI readback", async () => {
    await withGatewayCommands(async (cliJson) => {
      for (const variant of [
        { name: "finite-cap", toolsAllow: ["read"], allowUnsafeExternalContent: false },
        { name: "empty-cap", toolsAllow: [], allowUnsafeExternalContent: true },
      ]) {
        const sourceName = `Synthetic clone ${variant.name} source`;
        const payload = {
          kind: "agentTurn" as const,
          message: "node -e \"console.log('synthetic clone fixture')\"",
          toolsAllow: variant.toolsAllow,
          fallbacks: [],
          lightContext: false,
          allowUnsafeExternalContent: variant.allowUnsafeExternalContent,
          timeoutSeconds: 0,
        };
        const created = await seedPausedAgentJob(sourceName, payload);
        const sourceId = cronJobId(created);
        const original = await readStoredJob(sourceId);
        expect(original).toMatchObject({ id: sourceId, enabled: false });
        expect(original.payload).toEqual(payload);

        await withCronJobPage(cliJson, sourceId, async (evidence) => {
          const { page } = evidence;
          await expect
            .poll(() => page.locator(".cron-detail-title").textContent())
            .toBe(original.name);
          const menu = page.locator(".cron-detail-actions .cron-job-menu");
          await menu.locator(".cron-job-menu__trigger").click();
          await menu.locator('[data-value="clone"]').click();
          await page.locator('.cron-page[data-panel-mode="create"]').waitFor();
          await expect
            .poll(() => page.locator("#cron-name").inputValue())
            .toBe(`${sourceName} copy`);
          const cloneName = `Synthetic clone ${variant.name} copy`;
          await page.locator("#cron-name").fill(cloneName);
          const cloned = await submitCronForm(evidence, "cron.add", (id) =>
            cliJson(["automations", "get", id, "--json"]),
          );
          const cloneId = cronJobId(cloned.stored);
          await page.locator(`[data-test-id="cron-row-${cloneId}"]`).click();
          await expect.poll(() => page.locator(".cron-detail-title").textContent()).toBe(cloneName);
          const originalAfter = await readStoredJob(sourceId);

          expect.soft(originalAfter, `${variant.name}: source unchanged`).toEqual(original);
          expect.soft(cloneId, `${variant.name}: new job identity`).not.toBe(sourceId);
          expect.soft(cloned.stored, `${variant.name}: new disabled task`).toMatchObject({
            name: cloneName,
            agentId: "main",
            enabled: false,
            sessionTarget: "isolated",
            wakeMode: "now",
            delivery: { mode: "none" },
          });
          expect
            .soft(cloned.stored.schedule, `${variant.name}: exact schedule`)
            .toEqual(original.schedule);
          const params = requireRecord(cloned.request.params);
          const submittedPayload = requireRecord(params.payload);
          const storedPayload = requireRecord(cloned.stored.payload);
          expect
            .soft(submittedPayload, `${variant.name}: submitted payload`)
            .toMatchObject(payload);
          expect.soft(storedPayload, `${variant.name}: stored payload`).toMatchObject(payload);
          for (const field of ["toolsAllowIsDefault", "externalContentSource"]) {
            expect
              .soft(submittedPayload, `${variant.name}: omitted ${field}`)
              .not.toHaveProperty(field);
          }
          for (const field of [
            "createdActor",
            "toolsAllowProvenance",
            "toolsAllowExecTarget",
            "toolsAllowExecTargetRequirement",
            "runtimeAuthority",
            "runtimeAuthorityRecoveryRequired",
            "skillLibrarySelections",
          ]) {
            expect.soft(params, `${variant.name}: omitted ${field}`).not.toHaveProperty(field);
          }
        });
      }
    });
  });
});
