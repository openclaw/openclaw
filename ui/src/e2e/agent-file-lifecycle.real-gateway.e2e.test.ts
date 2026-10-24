import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { createRequireRecord } from "../../../test/helpers/record.js";
import type { ModelCatalogResult } from "../api/types.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { openPicker, pickerValue } from "../test-helpers/select-picker-e2e.ts";
import { selectAgentFileWorkspace } from "./agent-file-lifecycle.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent file lifecycle with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

let catalogInstance: OpenClawTestInstance;
let inventoryModel = "inventory-before";
const inventoryRequests: string[] = [];
const inventoryCommand = ["gateway", "call", "models.list", "--json", "--params"];
const inventoryArgs = (refresh?: true) => [
  ...inventoryCommand,
  JSON.stringify({ agentId: "main", view: "all", refresh }),
];
async function refreshInventory() {
  const expectedInventory = inventoryModel;
  let result = await catalogInstance.cli(inventoryArgs(true));
  expect(result.code, result.stderr).toBe(0);
  let catalog: ModelCatalogResult = JSON.parse(result.stdout);
  const inventory = () =>
    catalog.models.filter((model) => model.provider === "ollama").map((model) => model.id);
  // Publication can precede acquisition settlement; a refresh may still join the old acquisition.
  await expect
    .poll(async () => {
      if (catalog.pendingProviders?.length || !inventory().includes(expectedInventory)) {
        result = await catalogInstance.cli(
          inventoryArgs(catalog.pendingProviders?.length ? undefined : true),
        );
        expect(result.code, result.stderr).toBe(0);
        catalog = JSON.parse(result.stdout);
      }
      return { inventory: inventory(), pendingProviders: catalog.pendingProviders ?? [] };
    })
    .toEqual({ inventory: [expectedInventory], pendingProviders: [] });
  return result;
}
const catalogModels = (id: string) => [
  { id: "anchor", name: "Anchor" },
  { id: "selected", name: "Selected" },
  { id, name: id },
];
const catalogSuite = createControlUiE2eSuite({
  name: "Agents catalog publication with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const capabilities = ["completion", "tools"];
    const modelDetails = { capabilities, model_info: { "llama.context_length": 32768 } };
    const inventory = createServer((request, response) => {
      inventoryRequests.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      const tags = { models: [{ name: inventoryModel, capabilities }] };
      response.end(JSON.stringify(request.url === "/api/show" ? modelDetails : tags));
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
      await Promise.all([
        catalogInstance.cleanup(),
        new Promise<void>((resolve, reject) => {
          inventory.close((error) => (error ? reject(error) : resolve()));
        }),
      ]);
    };
    try {
      await catalogInstance.startGateway();
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
    const writeMethods = new Set(["config.set", "config.patch", "config.apply", "agents.update"]);
    const publicationEvents = new Set(["config.changed", "chat.metadata.changed"]);
    const catalogError = { code: "UNAVAILABLE", message: "Catalog transport unavailable" };
    let rejectCatalog = false;
    let holdCatalog = false;
    let receivedLatestCatalog = false;
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
    const readConfig = async (key: string) => {
      const result = await owner.cli(["config", "get", key, "--json"]);
      commands.push(result);
      expect(result.code, result.stderr || result.stdout).toBe(0);
      return JSON.parse(result.stdout);
    };
    const publishInventory = async (id: string, checkOutput = true) => {
      inventoryModel = id;
      const result = await refreshInventory();
      commands.push({ args: inventoryArgs(true), publishedInventory: result });
      if (checkOutput) {
        expect(result.stdout).toContain(id);
      }
    };
    try {
      await publishInventory("inventory-before");
      await catalogSuite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 1000, width: 1440 },
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
                if (writeMethods.has(String(frame.method))) {
                  mutations.push(String(frame.method));
                }
              }
              server.send(message);
            });
            server.onMessage((message) => {
              const frame = requireRecord(JSON.parse(message.toString()));
              const catalogReply = typeof frame.id === "string" && catalogRequests.has(frame.id);
              const transportFailure = catalogReply && rejectCatalog;
              if (catalogReply || publicationEvents.has(String(frame.event))) {
                frames.push({ direction: "received", frame, transportFailure });
              }
              if (catalogReply && holdCatalog) {
                const models = requireRecord(frame.payload).models;
                receivedLatestCatalog ||=
                  Array.isArray(models) &&
                  models.some((model) => requireRecord(model).id === "inventory-latest");
                heldCatalogs.push(() => socket.send(message));
              } else if (transportFailure) {
                const reply = { type: "res", id: frame.id, ok: false, error: catalogError };
                socket.send(JSON.stringify(reply));
              } else {
                socket.send(message);
              }
            });
          });
          await page.goto(url.toString());
          await waitForControlUiGatewayReady(page);
          const editor = page.locator("openclaw-agents-page");
          const picker = editor.locator(
            'openclaw-select-picker:has([role="listbox"][aria-label^="Primary model"])',
          );
          const option = (id: string) => picker.locator(`[role="option"][data-value="${id}"]`);
          const waitForOption = (id: string) => expect.poll(() => option(id).count()).toBe(1);
          await openPicker(picker);
          await waitForOption("fixture/retiring");
          const identityName = editor.getByRole("textbox", { name: "Display name", exact: true });
          // Identity hydration can replace the selection between fill's browser and keyboard steps.
          await expect.poll(() => identityName.inputValue()).toBe("Assistant");
          await identityName.fill("Keep this identity draft");
          expect(await identityName.inputValue()).toBe("Keep this identity draft");
          await openPicker(picker);
          await option("fixture/selected").click();
          const selected = () => pickerValue(picker);
          await expect.poll(selected).toBe("fixture/selected");
          await expect.poll(() => readConfig("agents.entries.main.model")).toBe("fixture/selected");
          const fallbacks = editor.locator("openclaw-multi-select.agent-fallbacks");
          const fallbackInput = fallbacks.locator("input");
          await expect.poll(() => fallbackInput.isEnabled()).toBe(true);
          await fallbackInput.fill("fixture/anchor");
          await fallbacks.locator('[role="option"][data-value="fixture/anchor"]').click();
          await expect
            .poll(() =>
              fallbacks.locator('.multi-select__chip[data-value="fixture/anchor"]').isVisible(),
            )
            .toBe(true);
          await expect.poll(selected).toBe("fixture/selected");
          const selectedModel = { primary: "fixture/selected", fallbacks: ["fixture/anchor"] };
          await expect.poll(() => readConfig("agents.entries.main.model")).toEqual(selectedModel);
          const writesBeforePublication = [...mutations];
          // Opening refreshes the catalog; verify publication updates closed choices first.
          const choices = () =>
            picker.evaluate((element) =>
              element
                .closest("openclaw-select-picker")
                ?.params.options.map((choice) => choice.value),
            );

          await publish("published");
          await expect.poll(choices).toContain("fixture/published");
          await openPicker(picker);
          await waitForOption("fixture/published");
          expect(await option("fixture/retiring").count()).toBe(0);

          await publishInventory("inventory-after");
          await waitForOption("ollama/inventory-after");
          expect(await option("ollama/inventory-before").count()).toBe(0);

          holdCatalog = true;
          await publishInventory("inventory-held", false);
          await expect.poll(() => heldCatalogs.length).toBeGreaterThan(0);
          await publishInventory("inventory-latest", false);
          await expect.poll(() => receivedLatestCatalog).toBe(true);
          holdCatalog = false;
          for (const release of heldCatalogs.splice(0)) {
            release();
          }
          await waitForOption("ollama/inventory-latest");
          expect(await option("ollama/inventory-held").count()).toBe(0);

          rejectCatalog = true;
          // Refresh the same catalog owner; a config write retires its display facts.
          await publishInventory("inventory-read-failure");
          const error = editor.getByRole("alert").filter({ hasText: catalogError.message });
          await error.waitFor({ state: "visible" });
          expect(await option("fixture/published").count()).toBe(1);

          rejectCatalog = false;
          await publish("recovered");
          await expect.poll(choices).toContain("fixture/recovered");
          await openPicker(picker);
          await waitForOption("fixture/recovered");
          await error.waitFor({ state: "hidden" });
          expect(await selected()).toBe("fixture/selected");
          expect(await identityName.inputValue()).toBe("Keep this identity draft");
          expect(
            await editor
              .locator(".multi-select__chip")
              .evaluateAll((chips) => chips.map((chip) => chip.getAttribute("data-value"))),
          ).toContain("fixture/anchor");
          expect(mutations).toEqual(writesBeforePublication);
          expect(await readConfig("agents.entries.main.model")).toEqual(selectedModel);
          expect(await readConfig("agents.defaults.model")).toBe("fixture/anchor");
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
    let fixture: OpenClawTestInstance | undefined;
    await suite.runScenario(context, {
      retainedState: () => fixture?.state.root,
      close: () => fixture?.stopGateway() ?? Promise.resolve(),
      release: () => fixture?.cleanup() ?? Promise.resolve(),
      run: async (signal) => {
        const owner = await createOpenClawTestInstance({
          name: "control-ui-agent-files",
          signal,
          config: {
            agents: {
              ownership: "explicit",
              defaults: {
                workspace: "~/.openclaw/workspace-main",
                systemAgent: { agentId: "main" },
                sessionStore: { agentId: "main" },
              },
              entries: {
                main: { workspace: "~/.openclaw/workspace-main" },
                writer: { workspace: "~/.openclaw/workspace-writer" },
              },
            },
            talk: { agentId: "main" },
            gateway: {
              auth: { mode: "none" },
              controlUi: {
                allowedOrigins: [new URL(suite.server.baseUrl).origin],
                enabled: false,
              },
            },
          },
        });
        fixture = owner;
        const { port } = owner;
        // Keep setup writes joined before the owner's cleanup can remove state.
        for (const agentId of ["main", "writer"]) {
          signal.throwIfAborted();
          await owner.state.writeText(
            `workspace-${agentId}/AGENTS.md`,
            `# Real ${agentId} instructions\n`,
          );
        }
        await owner.startGateway();
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
            const agentsFile = owner.state.statePath("workspace-main", "AGENTS.md");
            const readAgentsFile = () => readFile(agentsFile, "utf8");
            const saved = "# Saved through real Gateway\n";
            const draft = "# Operator draft that never saw the memory\n";
            const conflict = page.locator(".callout.danger");
            const save = page.locator(".agent-file-actions").getByRole("button", { name: "Save" });
            const rejectStaleSave = async (authoritative: string) => {
              await save.click();
              await expect.poll(() => conflict.isVisible()).toBe(true);
              expect(await readAgentsFile()).toBe(authoritative);
            };
            await expect.poll(() => editor.inputValue()).toBe("# Real main instructions\n");

            await selectAgentFileWorkspace(page, "writer");
            await expect.poll(() => editor.inputValue()).toBe("# Real writer instructions\n");

            await selectAgentFileWorkspace(page, "main");
            await expect.poll(() => editor.inputValue()).toBe("# Real main instructions\n");
            await editor.fill(saved);
            await save.click();
            await expect.poll(() => save.isDisabled()).toBe(true);
            await expect.poll(readAgentsFile).toBe(saved);

            const appended = `${saved}- agent appended a memory\n`;
            await writeFile(agentsFile, appended, "utf8");
            await editor.fill(draft);
            await rejectStaleSave(appended);
            await rejectStaleSave(appended);

            await conflict.getByRole("button", { name: "Overwrite" }).click();
            await expect.poll(readAgentsFile).toBe(draft);
            await expect.poll(() => conflict.isVisible()).toBe(false);

            const secondAppend = `${draft}- second memory\n`;
            await writeFile(agentsFile, secondAppend, "utf8");
            await editor.fill("# Another operator draft\n");
            await rejectStaleSave(secondAppend);
            await conflict.getByRole("button", { name: "Reload" }).click();
            await expect.poll(() => editor.inputValue()).toBe(secondAppend);
            expect(await readAgentsFile()).toBe(secondAppend);

            await editor.fill("# Draft typed before the refresh\n");
            const thirdAppend = `${secondAppend}- third memory\n`;
            await writeFile(agentsFile, thirdAppend, "utf8");
            await page
              .locator(".settings-section__header")
              .filter({ hasText: "Core Files" })
              .getByRole("button", { name: "Refresh" })
              .click();
            await expect.poll(() => editor.inputValue()).toBe("# Draft typed before the refresh\n");
            await rejectStaleSave(thirdAppend);

            await page
              .locator(".agent-file-header")
              .getByRole("button", { name: "Reset", exact: true })
              .click();
            await expect.poll(() => editor.inputValue()).toBe(thirdAppend);
            const afterReset = `${thirdAppend}- edited after Reset\n`;
            await editor.fill(afterReset);
            await save.click();
            await expect.poll(readAgentsFile).toBe(afterReset);
            await expect.poll(() => conflict.isVisible()).toBe(false);
          },
        );
      },
    });
  });
});
