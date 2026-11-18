import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { expect, it } from "vitest";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../../../test/helpers/openai-responses-model-fixture.ts";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { observeLayoutShifts } from "../test-helpers/control-ui-layout-shift.ts";
import { assertServedUi } from "./chat-lifecycle.test-support.ts";
import { connectChatGateway } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let instance: OpenClawTestInstance;
const captures: string[][] = [];
const suite = createControlUiE2eSuite({
  name: "Tool workflow graduation on a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const model = await startOpenAiResponsesModelServer({
      modelId: "workflow-preferred",
      bindError: "Tool workflow provider did not bind",
      onRequest: async (request, response) => {
        const body: { tools: Array<{ name: string }> } = JSON.parse(
          (await buffer(request)).toString("utf8"),
        );
        captures.push(body.tools.map((tool) => tool.name));
        writeOpenAiResponsesText(response, {
          text: "Tool workflow checked.",
          messageId: `workflow-message-${captures.length}`,
          responseId: `workflow-response-${captures.length}`,
        });
      },
    });
    const modelConfig = createOpenAiResponsesModelConfig({
      baseUrl: model.baseUrl,
      providerId: "openai",
      modelId: "workflow-preferred",
      reasoning: false,
      toolProfile: "full",
    });
    const preferred = modelConfig.models!.providers!.openai!.models![0]!;
    preferred.compat = { codeMode: "preferred" };
    modelConfig.models!.providers!.openai!.models!.push({
      ...preferred,
      id: "workflow-capable",
      name: "workflow-capable",
      compat: { codeMode: "capable" },
    });
    modelConfig.agents!.defaults!.models!["openai/workflow-capable"] = {
      agentRuntime: { id: "openclaw" },
    };
    const close = () =>
      runQaGatewayFixture(
        () => instance?.cleanup(),
        () => model.close(),
      );
    try {
      instance = await createOpenClawTestInstance({
        name: "labs-graduation",
        entrypoint: ["dist/index.js"],
        env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
        config: {
          ...modelConfig,
          models: { ...modelConfig.models, catalogRefresh: { enabled: false } },
          gateway: { controlUi: { enabled: true }, reload: { mode: "hybrid" } },
          plugins: { allow: ["openai"], slots: { memory: "none" } },
          cron: { enabled: false },
          update: { checkOnStart: false },
          logging: { level: "info", consoleLevel: "error" },
        },
      });
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
    } catch (error) {
      return runQaGatewayFixture(async (): Promise<never> => {
        throw error;
      }, close);
    }
  },
});

suite.define(() => {
  it("saves ordinary controls live without changing model eligibility or defaulting saved choices", async (test) => {
    const client = await connectChatGateway(instance, test.signal);
    const artifacts = createControlUiE2eArtifactDir("labs-graduation-after");
    const handoff = await instance.cli(["dashboard", "--json"]);
    expect(handoff.code, handoff.stderr).toBe(0);
    const { browserUrl } = JSON.parse(handoff.stdout);
    const pid = instance.child?.pid;
    let run = 0;
    const surfaceFor = async (model: "preferred" | "capable") => {
      const key = `agent:main:tool-workflow-${++run}`;
      await client.request("sessions.create", {
        key,
        agentId: "main",
        label: `Tool workflow proof ${run}`,
      });
      await client.request("sessions.patch", { key, model: `openai/workflow-${model}` });
      const count = captures.length;
      await client.request("chat.send", {
        sessionKey: key,
        message: "Confirm this synthetic tool workflow.",
        idempotencyKey: `tool-workflow-${run}`,
      });
      await expect.poll(() => captures.length).toBe(count + 1);
      await expect
        .poll(() => client.request("chat.history", { sessionKey: key }))
        .toMatchObject({ sessionInfo: { hasActiveRun: false } });
      return captures[count]!;
    };
    try {
      expect(await surfaceFor("preferred")).toEqual(expect.arrayContaining(["exec", "wait"]));
      expect(await surfaceFor("capable")).toEqual(
        expect.arrayContaining(["tool_search", "dispatch_action"]),
      );
      await suite.withPage(
        {
          colorScheme: "dark",
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 1280, height: 1300 },
        },
        async ({ page }) => {
          const labs = new URL("settings/labs", browserUrl);
          labs.hash = new URL(browserUrl).hash;
          await page.goto(labs.href);
          await waitForControlUiGatewayReady(page);
          await page.getByRole("switch", { name: "Decision assistance", exact: true }).waitFor();
          expect(await page.getByRole("switch", { name: "Code Mode", exact: true }).count()).toBe(
            0,
          );
          expect(
            await page
              .getByRole("switch", { name: "Tool search for all models", exact: true })
              .count(),
          ).toBe(0);
          const labsSurface = page.locator("openclaw-labs-page .settings-section");
          const labsFrame = await takeControlUiScreenshotFrame(page, labsSurface, [labsSurface], {
            animations: "disabled",
          });
          await writeFile(path.join(artifacts, "labs-after-clean.png"), labsFrame.png);
          const tools = new URL("settings/ai-agents?section=tools", browserUrl);
          await page.goto(tools.href);
          await waitForControlUiGatewayReady(page);
          await assertServedUi(page, suite.server.baseUrl, path.resolve("."));
          const code = page.getByRole("switch", { name: "Code Mode", exact: true });
          const search = page.getByRole("switch", { name: "Tool Search", exact: true });
          await expect.poll(() => code.isChecked()).toBe(true);
          await expect.poll(() => search.isChecked()).toBe(true);
          const saved = () =>
            evaluateControlUiContext(page, (app) => ({
              dirty: app.runtimeConfig.state.configFormDirty,
              status: app.runtimeConfig.state.configAutoSaveStatus,
            }));
          await code.uncheck();
          await expect.poll(saved).toEqual({ dirty: false, status: "saved" });
          await search.uncheck();
          await expect.poll(saved).toEqual({ dirty: false, status: "saved" });
          const off = await surfaceFor("preferred");
          expect(off).not.toContain("tool_search");
          expect(off).not.toContain("wait");
          expect(off).toContain("read");
          await code.check();
          await expect.poll(saved).toEqual({ dirty: false, status: "saved" });
          await search.check();
          await expect.poll(saved).toEqual({ dirty: false, status: "saved" });
          const config = JSON.parse(await readFile(instance.configPath, "utf8"));
          expect(config.tools.codeMode).toEqual({ enabled: "auto" });
          expect(config.tools.toolSearch).toEqual({ enabled: true });
          expect(await surfaceFor("preferred")).toEqual(expect.arrayContaining(["exec", "wait"]));
          const capable = await surfaceFor("capable");
          expect(capable).not.toContain("wait");
          expect(capable).toContain("tool_search");
          expect(instance.child?.pid).toBe(pid);
          const codeRow = page.locator(".settings-row", { has: code });
          const searchRow = page.locator(".settings-row", { has: search });
          const frame = await takeControlUiScreenshotFrame(page, codeRow, [codeRow, searchRow], {
            elements: [codeRow, searchRow],
            animations: "disabled",
            scrollTo: codeRow,
          });
          await writeFile(path.join(artifacts, "tools-after-clean.png"), frame.png);
          await writeFile(
            path.join(artifacts, "tools-after-bounds.json"),
            JSON.stringify({
              viewport: page.viewportSize(),
              scale: await page.evaluate(() => devicePixelRatio),
              bounds: frame.elements.map((element) => element.bounds),
            }),
          );
          console.info(`GRADUATION_PROOF=${artifacts}`);
        },
      );
      const layout: Array<{ width: number; cls: number; entries: number }> = [];
      for (const width of [400, 820, 1280]) {
        await suite.withPage(
          {
            colorScheme: "dark",
            locale: "en-US",
            serviceWorkers: "block",
            viewport: { width, height: 1300 },
          },
          async ({ page }) => {
            const layoutHandoff = await instance.cli(["dashboard", "--json"]);
            expect(layoutHandoff.code, layoutHandoff.stderr).toBe(0);
            const { browserUrl: layoutUrl } = JSON.parse(layoutHandoff.stdout);
            const agents = new URL("settings/agents", layoutUrl);
            agents.hash = new URL(layoutUrl).hash;
            await page.goto(agents.href);
            await waitForControlUiGatewayReady(page);
            await page.getByRole("button", { name: /^Agent defaults/ }).click();
            await page.getByRole("heading", { name: "Agent defaults", exact: true }).waitFor();
            const tools = page.getByRole("tab", { name: "Tools", exact: true });
            await tools.waitFor();
            const shifts = await observeLayoutShifts(page);
            try {
              await tools.click();
              const code = page.getByRole("switch", { name: "Code Mode", exact: true });
              const row = page.locator(".settings-row", { has: code });
              const frame = await takeControlUiScreenshotFrame(page, row, [row], {
                animations: "disabled",
              });
              await writeFile(path.join(artifacts, `tools-after-${width}.png`), frame.png);
              const result = await shifts.evaluate((probe) => probe.read());
              layout.push({ width, cls: result.value, entries: result.entries.length });
              await writeFile(path.join(artifacts, `layout-${width}.json`), JSON.stringify(result));
              expect(result.value, `Tools navigation layout shift at ${width}px`).toBe(0);
            } finally {
              await shifts.evaluate((probe) => probe.stop());
              await shifts.dispose();
            }
          },
        );
      }
      await writeFile(path.join(artifacts, "layout-probes.json"), JSON.stringify(layout, null, 2));
    } finally {
      await client.stopAndWait();
      await writeFile(
        path.join(artifacts, "tool-surfaces.json"),
        JSON.stringify(captures, null, 2),
      );
    }
  });
});
