// Real Gateway proof for browser agent selection and persisted workspace saves.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import type { GatewayClient } from "../../../src/gateway/client.ts";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { loadOrCreateDeviceIdentity } from "../../../src/infra/device-identity.ts";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelCatalogResult } from "../api/types.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { pickerValue } from "../test-helpers/select-picker-e2e.ts";
import {
  captureAgentFileScreenshot,
  selectAgentFileWorkspace,
} from "./agent-file-lifecycle.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const captureEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

const suite = createControlUiE2eSuite({
  name: "Control UI agent file lifecycle with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

let catalogInstance: OpenClawTestInstance;
let inventoryModel = "inventory-before";
let catalogObserver: GatewayClient | undefined;
let catalogChanged = createDeferred<void>();
const inventoryRequests: string[] = [];
const refreshInventoryArgs = [
  "gateway",
  "call",
  "models.list",
  "--json",
  "--params",
  JSON.stringify({ agentId: "main", view: "all", refresh: true }),
];
type InventoryRefreshSource = {
  refresh: () => ReturnType<OpenClawTestInstance["cli"]>;
  read: () => Promise<ModelCatalogResult>;
  nextPublication: () => Promise<void>;
  requests: () => readonly string[];
};
const inventoryRefreshSource: InventoryRefreshSource = {
  refresh: () => catalogInstance.cli(refreshInventoryArgs),
  read: () =>
    catalogObserver!.request<ModelCatalogResult>("models.list", {
      agentId: "main",
      view: "all",
    }),
  nextPublication: () => catalogChanged.promise,
  requests: () => inventoryRequests,
};
async function beginInventoryRefresh(source = inventoryRefreshSource) {
  const requestsBefore = source.requests().length;
  const changed = source.nextPublication();
  const command = await source.refresh();
  expect(command.code, command.stderr).toBe(0);
  const foreground: ModelCatalogResult = JSON.parse(command.stdout);
  return { command, foreground, changed, requestsBefore };
}
async function awaitInventoryPublication(
  started: Awaited<ReturnType<typeof beginInventoryRefresh>>,
  source = inventoryRefreshSource,
) {
  let { foreground: catalog, changed } = started;
  while (catalog.pendingProviders?.length) {
    await changed;
    changed = source.nextPublication();
    catalog = await source.read();
  }
  return {
    command: started.command,
    foreground: started.foreground,
    catalog,
    providerRequests: source.requests().slice(started.requestsBefore),
  };
}
function containsPublishedInventory(payload: unknown, id: string): boolean {
  const catalog = createRequireRecord("record", "expected-label-record")(payload, "catalog result");
  const pending = catalog.pendingProviders;
  return (
    (pending === undefined || (Array.isArray(pending) && pending.length === 0)) &&
    Array.isArray(catalog.models) &&
    catalog.models.some((row) => {
      const model = createRequireRecord("record", "expected-label-record")(row, "model row");
      return model.provider === "ollama" && model.id === id;
    })
  );
}

it("catalog refresh helper separates foreground completion from held publication", async () => {
  const publication = createDeferred<void>();
  const heldResponse = createDeferred<ModelCatalogResult>();
  const held: ModelCatalogResult = {
    models: [{ provider: "ollama", id: "inventory-held", name: "Held" }],
  };
  const latest: ModelCatalogResult = {
    models: [{ provider: "ollama", id: "inventory-latest", name: "Latest" }],
  };
  const foreground: ModelCatalogResult = { ...held, pendingProviders: ["ollama"] };
  let refreshes = 0;
  let reads = 0;
  let foregroundReturned = false;
  let heldSettled = false;
  const source: InventoryRefreshSource = {
    refresh: async () => ({
      code: 0,
      signal: null,
      stderr: "",
      stdout: JSON.stringify(++refreshes === 1 ? foreground : latest),
    }),
    nextPublication: () => publication.promise,
    requests: () => [],
    read: async () => {
      reads += 1;
      return heldResponse.promise;
    },
  };
  const first = beginInventoryRefresh(source).then((value) => {
    foregroundReturned = true;
    return value;
  });
  let settling: ReturnType<typeof awaitInventoryPublication> | undefined;
  try {
    // The synthetic foreground RPC is already resolved; fence its queued continuations.
    // Neither publication nor its deliberately held response has been released.
    await nextTurn();
    expect(foregroundReturned).toBe(true);
    expect(reads).toBe(0);
    const started = await first;
    expect(started.foreground).toEqual(foreground);
    expect(containsPublishedInventory(started.foreground, "inventory-held")).toBe(false);
    settling = awaitInventoryPublication(started, source).then((value) => {
      heldSettled = true;
      return value;
    });
    publication.resolve();
    await nextTurn();
    expect(reads).toBe(1);
    expect(heldSettled).toBe(false);

    const newest = await awaitInventoryPublication(await beginInventoryRefresh(source), source);
    expect(newest.catalog).toEqual(latest);
    expect(heldSettled).toBe(false);
    expect(refreshes).toBe(2);
    heldResponse.resolve(held);
    expect((await settling).catalog).toEqual(held);
    expect(containsPublishedInventory(held, "inventory-held")).toBe(true);
    expect(newest.catalog).toEqual(latest);
    expect(reads).toBe(1);
    console.log(
      "CATALOG_HELPER_HELD_CONTROL",
      JSON.stringify({ refreshes, reads, foregroundReturned, heldSettled }),
    );
  } finally {
    publication.resolve();
    heldResponse.resolve(held);
    await first;
    await settling;
  }
});

const catalogModels = (id: string) => [
  { id: "anchor", name: "Anchor" },
  { id: "selected", name: "Selected" },
  { id, name: id },
];
const catalogSuite = createControlUiE2eSuite({
  name: "Agents catalog publication with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const inventory = createServer((request, response) => {
      inventoryRequests.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/api/show"
            ? {
                capabilities: ["completion", "tools"],
                model_info: { "llama.context_length": 32768 },
              }
            : { models: [{ name: inventoryModel, capabilities: ["completion", "tools"] }] },
        ),
      );
    });
    const inventoryPort = await getFreePort();
    await new Promise<void>((resolve) => {
      inventory.listen(inventoryPort, "127.0.0.1", resolve);
    });
    catalogInstance = await createOpenClawTestInstance({
      name: "agents-catalog-publication",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: {
        gateway: { controlUi: { enabled: true } },
        agents: {
          defaults: {
            model: "fixture/anchor",
            modelPolicy: { allow: ["fixture/*", "ollama/*"] },
          },
        },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            ollama: { api: "ollama", baseUrl: `http://127.0.0.1:${inventoryPort}` },
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
    const close = async () => {
      await catalogObserver?.stopAndWait();
      catalogObserver = undefined;
      await Promise.all([
        catalogInstance.cleanup(),
        new Promise<void>((resolve, reject) => {
          inventory.close((error) => (error ? reject(error) : resolve()));
        }),
      ]);
    };
    try {
      await catalogInstance.startGateway();
      catalogObserver = await acquireGatewayTestClient(
        {
          url: catalogInstance.url,
          token: catalogInstance.gatewayToken,
          clientName: "test",
          mode: "test",
          scopes: ["operator.admin"],
          sharedStateMode: "read-only",
          deviceIdentity: loadOrCreateDeviceIdentity({
            path: catalogInstance.state.statePath("catalog-observer-device.sqlite"),
          }),
          onEvent: ({ event }) => {
            if (event === "chat.metadata.changed") {
              catalogChanged.resolve();
              catalogChanged = createDeferred<void>();
            }
          },
        },
        {
          timeoutMs: 10_000,
          timeoutMessage: "Catalog observer connection timed out",
          closeMessage: "Catalog observer closed",
        },
      );
      const initialInventory = await awaitInventoryPublication(await beginInventoryRefresh());
      expect(initialInventory.catalog.models).toContainEqual(
        expect.objectContaining({ provider: "ollama", id: "inventory-before" }),
      );
      return {
        baseUrl: `http://127.0.0.1:${catalogInstance.port}/`,
        close,
      };
    } catch (error) {
      await writeFile(path.join(catalogSuite.artifactDir, "startup.log"), catalogInstance.logs());
      await writeFile(
        path.join(catalogSuite.artifactDir, "inventory-requests.json"),
        JSON.stringify(inventoryRequests),
      );
      await close();
      throw error;
    }
  },
});

catalogSuite.define(() => {
  it("refreshes an open Agents editor after catalog publication without losing drafts", async () => {
    const owner = catalogInstance;
    const requireRecord = createRequireRecord("record", "expected-object-value");
    const handoff = await owner.cli(["dashboard", "--json"]);
    expect(handoff.code, handoff.stderr).toBe(0);
    const browserUrl = requireRecord(JSON.parse(handoff.stdout)).browserUrl;
    if (typeof browserUrl !== "string") {
      throw new Error("Dashboard did not return a browser handoff");
    }
    const url = new URL("settings/agents/main/overview", browserUrl);
    url.hash = new URL(browserUrl).hash;
    const frames: unknown[] = [];
    const commands: unknown[] = [];
    const catalogRequests = new Set<string>();
    const mutations: string[] = [];
    let rejectCatalog = false;
    let holdCatalog = false;
    let heldInventoryPublished = false;
    const heldCatalogs: Array<() => void> = [];
    const publish = async (id: string) => {
      const args = [
        "config",
        "set",
        "models.providers.fixture.models",
        JSON.stringify(catalogModels(id)),
        "--strict-json",
        "--replace",
      ];
      const result = await owner.cli(args);
      commands.push({ args, ...result });
      expect(result.code, result.stderr).toBe(0);
    };
    try {
      await catalogSuite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 1000, width: 1440 },
          ...(captureEnabled ? { recordVideo: { dir: catalogSuite.artifactDir } } : {}),
        },
        async ({ page }) => {
          await page.routeWebSocket(`ws://127.0.0.1:${owner.port}/**`, (socket) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => {
              const frame = requireRecord(JSON.parse(message.toString()));
              if (frame.type === "req" && frame.method !== "connect") {
                frames.push({ direction: "sent", frame });
                if (frame.method === "models.list" && typeof frame.id === "string") {
                  catalogRequests.add(frame.id);
                }
                if (
                  ["config.set", "config.patch", "config.apply", "agents.update"].includes(
                    String(frame.method),
                  )
                ) {
                  mutations.push(String(frame.method));
                }
              }
              server.send(message);
            });
            server.onMessage((message) => {
              const frame = requireRecord(JSON.parse(message.toString()));
              const catalogReply = typeof frame.id === "string" && catalogRequests.has(frame.id);
              if (
                catalogReply ||
                frame.event === "config.changed" ||
                frame.event === "chat.metadata.changed"
              ) {
                frames.push({
                  direction: "received",
                  frame,
                  transportFailure: catalogReply && rejectCatalog,
                });
              }
              if (
                catalogReply &&
                holdCatalog &&
                frame.ok === true &&
                containsPublishedInventory(frame.payload, "inventory-held")
              ) {
                // Pending replies must remain deliverable so the browser can request
                // the completed old publication that this scenario holds back.
                heldCatalogs.push(() => socket.send(message));
                heldInventoryPublished = true;
              } else if (catalogReply && rejectCatalog) {
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
          const editor = page.locator("openclaw-agents-page");
          const picker = editor.locator(".model-picker__select");
          await expect
            .poll(() => picker.locator('[role="option"][data-value="fixture/retiring"]').count())
            .toBe(1);
          await editor
            .locator(".agent-identity-editor__fields input[maxlength='64']")
            .fill("Keep this identity draft");
          await picker.locator(".picker-select__trigger").click();
          await picker.locator('[role="option"][data-value="fixture/selected"]').click();
          const fallbackInput = editor.locator("openclaw-multi-select.agent-fallbacks input");
          await fallbackInput.fill("fixture/anchor");
          await fallbackInput.press("Enter");
          const selected = () => pickerValue(picker);
          await expect.poll(selected).toBe("fixture/selected");
          await expect.poll(() => mutations.length).toBeGreaterThan(0);
          await expect
            .poll(async () => {
              const result = await owner.cli([
                "config",
                "get",
                "agents.entries.main.model",
                "--json",
              ]);
              return result.code === 0 ? JSON.parse(result.stdout) : null;
            })
            .toEqual({ primary: "fixture/selected", fallbacks: ["fixture/anchor"] });
          const writesBeforePublication = [...mutations];
          if (captureEnabled) {
            await page.screenshot({ path: path.join(catalogSuite.artifactDir, "initial.png") });
          }

          await publish("published");
          await expect
            .poll(() => picker.locator('[role="option"][data-value="fixture/published"]').count())
            .toBe(1);
          expect(
            await picker.locator('[role="option"][data-value="fixture/retiring"]').count(),
          ).toBe(0);
          if (captureEnabled) {
            await page.screenshot({ path: path.join(catalogSuite.artifactDir, "published.png") });
          }

          inventoryModel = "inventory-after";
          const refreshed = await awaitInventoryPublication(await beginInventoryRefresh());
          commands.push({ args: refreshInventoryArgs, ...refreshed });
          expect(refreshed.catalog.models).toContainEqual(
            expect.objectContaining({ provider: "ollama", id: "inventory-after" }),
          );
          await expect
            .poll(() =>
              picker.locator('[role="option"][data-value="ollama/inventory-after"]').count(),
            )
            .toBe(1);
          expect(
            await picker.locator('[role="option"][data-value="ollama/inventory-before"]').count(),
          ).toBe(0);

          holdCatalog = true;
          inventoryModel = "inventory-held";
          commands.push(await beginInventoryRefresh());
          // Observe the completed old inventory on the held browser connection before
          // starting a distinct refresh. A pending response is not this publication.
          await expect.poll(() => heldInventoryPublished).toBe(true);
          holdCatalog = false;
          inventoryModel = "inventory-latest";
          commands.push(await awaitInventoryPublication(await beginInventoryRefresh()));
          await expect
            .poll(() =>
              picker.locator('[role="option"][data-value="ollama/inventory-latest"]').count(),
            )
            .toBe(1);
          for (const release of heldCatalogs) {
            release();
          }
          // Fence the released replies on this connection before checking that stale data was ignored.
          await page.evaluate(async () => {
            // SAFETY: Gateway readiness above establishes this app's connected runtime.
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime: { context: { gateway: { snapshot: { client: GatewayBrowserClient } } } };
            };
            await app.runtime.context.gateway.snapshot.client.request("health", {});
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            });
          });
          if (captureEnabled) {
            await page.screenshot({
              path: path.join(catalogSuite.artifactDir, "latest-publication.png"),
            });
          }
          expect(
            await picker.locator('[role="option"][data-value="ollama/inventory-latest"]').count(),
          ).toBe(1);
          expect(
            await picker.locator('[role="option"][data-value="ollama/inventory-held"]').count(),
          ).toBe(0);

          rejectCatalog = true;
          await publish("held");
          const error = editor
            .getByRole("alert")
            .filter({ hasText: "Catalog transport unavailable" });
          await error.waitFor({ state: "visible" });
          expect(
            await picker.locator('[role="option"][data-value="fixture/published"]').count(),
          ).toBe(1);
          if (captureEnabled) {
            await page.screenshot({
              path: path.join(catalogSuite.artifactDir, "read-failure.png"),
            });
          }

          rejectCatalog = false;
          await publish("recovered");
          await expect
            .poll(() => picker.locator('[role="option"][data-value="fixture/recovered"]').count())
            .toBe(1);
          await error.waitFor({ state: "hidden" });
          expect(await selected()).toBe("fixture/selected");
          expect(
            await editor
              .locator(".agent-identity-editor__fields input[maxlength='64']")
              .inputValue(),
          ).toBe("Keep this identity draft");
          expect(
            await editor
              .locator(".multi-select__chip")
              .evaluateAll((chips) => chips.map((chip) => chip.getAttribute("data-value"))),
          ).toContain("fixture/anchor");
          expect(mutations).toEqual(writesBeforePublication);
          const persistedModel = await owner.cli([
            "config",
            "get",
            "agents.entries.main.model",
            "--json",
          ]);
          commands.push(persistedModel);
          expect(persistedModel.code, persistedModel.stderr).toBe(0);
          expect(JSON.parse(persistedModel.stdout)).toEqual({
            primary: "fixture/selected",
            fallbacks: ["fixture/anchor"],
          });
          const persisted = await owner.cli(["config", "get", "agents.defaults.model", "--json"]);
          commands.push(persisted);
          expect(persisted.code, persisted.stderr).toBe(0);
          expect(JSON.parse(persisted.stdout)).toBe("fixture/anchor");
          if (captureEnabled) {
            await page.screenshot({ path: path.join(catalogSuite.artifactDir, "recovered.png") });
          }
        },
      );
    } finally {
      const redact = (value: string) =>
        value
          .replaceAll(owner.gatewayToken, "[synthetic token]")
          .replaceAll(owner.hookToken, "[synthetic token]");
      await writeFile(
        path.join(catalogSuite.artifactDir, "publication.json"),
        redact(JSON.stringify({ frames, commands, inventoryRequests }, null, 2)),
      );
      await writeFile(path.join(catalogSuite.artifactDir, "gateway.log"), redact(owner.logs()));
    }
  }, 120_000);
});

suite.define(() => {
  it("reads and saves the selected agent workspace through an isolated Gateway", async (context) => {
    let fixture: OpenClawTestState | undefined;
    let gateway: Promise<GatewayServer> | undefined;
    await suite.runScenario(context, {
      retainedState: () => fixture?.root,
      close: async () => {
        const server = await gateway;
        await server?.close({ reason: "agent file lifecycle e2e cleanup" });
      },
      release: async () => {
        await fixture?.cleanup();
      },
      run: async (signal) => {
        const port = await getFreePort();
        signal.throwIfAborted();
        const state = await createOpenClawTestState({
          label: "control-ui-agent-files",
          layout: "home",
          env: {
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_CRON: "1",
            OPENCLAW_SKIP_GMAIL_WATCHER: "1",
            OPENCLAW_SKIP_PROVIDERS: "1",
            OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
            VITEST: "1",
          },
        });
        fixture = state;
        signal.throwIfAborted();
        const mainWorkspace = state.path("workspace-main");
        const writerWorkspace = state.path("workspace-writer");
        // A failed setup must not leave sibling writes running beyond cleanup.
        for (const [workspace, content] of [
          [mainWorkspace, "# Real main instructions\n"],
          [writerWorkspace, "# Real writer instructions\n"],
        ] as const) {
          signal.throwIfAborted();
          await mkdir(workspace, { recursive: true });
          signal.throwIfAborted();
          await writeFile(path.join(workspace, "AGENTS.md"), content, "utf8");
        }
        signal.throwIfAborted();
        await state.writeConfig({
          agents: {
            defaults: { workspace: mainWorkspace },
            entries: {
              main: { default: true, workspace: mainWorkspace },
              writer: { workspace: writerWorkspace },
            },
          },
          gateway: {
            auth: { mode: "none" },
            controlUi: {
              allowedOrigins: [new URL(suite.server.baseUrl).origin],
              enabled: false,
            },
            port,
          },
        });
        signal.throwIfAborted();
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        signal.throwIfAborted();
        gateway = startGatewayServer(port, {
          auth: { mode: "none" },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        await gateway;
        signal.throwIfAborted();

        await suite.withPage(
          {
            locale: "en-US",
            serviceWorkers: "block",
            viewport: { height: 900, width: 1440 },
          },
          async ({ page }) => {
            const url = new URL("settings/agents/main/files", suite.server.baseUrl);
            url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
            await page.goto(url.toString());
            const confirmation = page.locator("openclaw-gateway-url-confirmation");
            await confirmation.waitFor();
            await confirmation
              .getByRole("button", { name: `Switch to 127.0.0.1:${port}`, exact: true })
              .click();
            const editor = page.locator(".agent-file-textarea");
            await expect.poll(() => editor.inputValue()).toBe("# Real main instructions\n");

            await selectAgentFileWorkspace(page, "writer");
            await expect.poll(() => editor.inputValue()).toBe("# Real writer instructions\n");

            await selectAgentFileWorkspace(page, "main");
            await expect.poll(() => editor.inputValue()).toBe("# Real main instructions\n");
            await editor.fill("# Saved through real Gateway\n");
            const save = page.locator(".agent-file-actions").getByRole("button", { name: "Save" });
            await save.click();
            await expect.poll(() => save.isDisabled()).toBe(true);
            await expect
              .poll(() => readFile(path.join(mainWorkspace, "AGENTS.md"), "utf8"))
              .toBe("# Saved through real Gateway\n");
            await captureAgentFileScreenshot(page, "07-real-gateway-main-save.png");

            const agentsFile = path.join(mainWorkspace, "AGENTS.md");
            const appended = "# Saved through real Gateway\n- agent appended a memory\n";
            await writeFile(agentsFile, appended, "utf8");
            await editor.fill("# Operator draft that never saw the memory\n");
            await save.click();
            const conflict = page.locator(".callout.danger");
            await expect.poll(() => conflict.isVisible()).toBe(true);
            expect(await readFile(agentsFile, "utf8")).toBe(appended);
            await captureAgentFileScreenshot(page, "08-real-gateway-stale-save-refused.png");

            await save.click();
            await expect.poll(() => conflict.isVisible()).toBe(true);
            expect(await readFile(agentsFile, "utf8")).toBe(appended);

            await conflict.getByRole("button", { name: "Overwrite" }).click();
            await expect
              .poll(() => readFile(agentsFile, "utf8"))
              .toBe("# Operator draft that never saw the memory\n");
            await expect.poll(() => conflict.isVisible()).toBe(false);

            const secondAppend = "# Operator draft that never saw the memory\n- second memory\n";
            await writeFile(agentsFile, secondAppend, "utf8");
            await editor.fill("# Another operator draft\n");
            await save.click();
            await expect.poll(() => conflict.isVisible()).toBe(true);
            expect(await readFile(agentsFile, "utf8")).toBe(secondAppend);
            await conflict.getByRole("button", { name: "Reload" }).click();
            await expect.poll(() => editor.inputValue()).toBe(secondAppend);
            expect(await readFile(agentsFile, "utf8")).toBe(secondAppend);
            await captureAgentFileScreenshot(page, "09-real-gateway-conflict-reloaded.png");

            await editor.fill("# Draft typed before the refresh\n");
            const thirdAppend = `${secondAppend}- third memory\n`;
            await writeFile(agentsFile, thirdAppend, "utf8");
            await page
              .locator(".settings-section__header")
              .filter({ hasText: "Core Files" })
              .getByRole("button", { name: "Refresh" })
              .click();
            await expect.poll(() => editor.inputValue()).toBe("# Draft typed before the refresh\n");
            await save.click();
            await expect.poll(() => conflict.isVisible()).toBe(true);
            expect(await readFile(agentsFile, "utf8")).toBe(thirdAppend);
            await captureAgentFileScreenshot(page, "10-real-gateway-refresh-then-save.png");

            await page
              .locator(".agent-file-header")
              .getByRole("button", { name: "Reset", exact: true })
              .click();
            await expect.poll(() => editor.inputValue()).toBe(thirdAppend);
            const afterReset = `${thirdAppend}- edited after Reset\n`;
            await editor.fill(afterReset);
            await save.click();
            await expect.poll(() => readFile(agentsFile, "utf8")).toBe(afterReset);
            await expect.poll(() => conflict.isVisible()).toBe(false);
            await captureAgentFileScreenshot(page, "11-real-gateway-reset-then-save.png");
          },
        );
      },
    });
  });
});
