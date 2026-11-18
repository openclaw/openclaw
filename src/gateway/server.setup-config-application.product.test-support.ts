import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { readConfiguredLogTail } from "../logging/log-tail.js";
import { testApi as loggerTest } from "../logging/logger.test-support.js";
import { resolvePluginArtifactDeclaredSurface } from "../plugins/capability-artifact.js";
import { resolvePluginCapabilityConsent } from "../plugins/capability-consent.js";
import { computeDeclaredSurfaceHash } from "../plugins/capability-summary.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { output, type InputItem } from "./server.plugin-reload-product-fixture.test-support.js";
import { startSetupProductGateway } from "./server.setup-config-application.product-host.test-support.js";
import { createSubagentModelConfig } from "./server.subagent-stop-settlement.product.test-support.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";

const PLUGIN = "setup-application-proof";
const TOOL = "setup_application_probe";
const HOLD = "SETUP-APPLICATION-HOLD-75d1";
const PROBE = "SETUP-APPLICATION-NEW-75d1";

it("keeps saved and active config distinct until a real plugin turn releases", async ({
  signal,
}) => {
  const started = performance.now();
  const stage = (name: string) =>
    process.stderr.write(
      `SETUP_PRODUCT_STAGE ${name} ${Math.round(performance.now() - started)}ms\n`,
    );
  stage("fixture");
  const state = await createOpenClawTestState(kernelGatewayTestStateOptions("setup-application"));
  const held = createDeferred();
  const release = createDeferred();
  const applied = createDeferred();
  const newValue = createDeferred<Record<string, unknown>>();
  const failed = createDeferred<never>();
  void failed.promise.catch(() => {});
  let gateway: Awaited<ReturnType<typeof startSetupProductGateway>> | undefined;
  let model: Awaited<ReturnType<typeof startOpenAiResponsesModelServer>> | undefined;
  const activeValue = () => getRuntimeConfigSnapshot()?.plugins?.entries?.[PLUGIN]?.config?.value;
  const unwatch = sessionChanges.subscribe(() => {
    if (activeValue() === "new") {
      applied.resolve();
    }
  });
  const wait = <T>(promise: Promise<T>) =>
    withinTest(Promise.race([promise, failed.promise]), signal);
  try {
    const pluginRoot = state.path("external-plugin");
    await fs.mkdir(pluginRoot, { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        name: PLUGIN,
        version: "1.0.0",
        openclaw: { extensions: ["./index.cjs"] },
      }),
    );
    await fs.writeFile(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: PLUGIN,
        contracts: { tools: [TOOL] },
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      }),
    );
    // Capture configuration at real plugin registration, not from the mutable file.
    await fs.writeFile(
      path.join(pluginRoot, "index.cjs"),
      `
module.exports = { id: ${JSON.stringify(PLUGIN)}, register(api) {
  const value = api.pluginConfig.value;
  api.registerTool({ name: ${JSON.stringify(TOOL)}, label: "Setup application probe",
    description: "Return the configuration owned by this plugin instance",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: JSON.stringify({ value }) }] }; }
  });
} };`,
    );
    model = await startOpenAiResponsesModelServer({
      modelId: "setup-application-proof",
      bindError: "Cannot start the local model fixture",
      onRequest: async (request, response) => {
        try {
          const raw = await readRequestText(request);
          const body = JSON.parse(raw) as { input?: InputItem[] };
          const result = output(body, TOOL);
          if (raw.includes(HOLD) || raw.includes(PROBE)) {
            if (!result) {
              writeToolCall(response, TOOL, {});
              return;
            }
            if (raw.includes(HOLD)) {
              expect(result).toEqual({ value: "old" });
              stage("model-tool-output-held");
              held.resolve();
              await release.promise;
            } else {
              newValue.resolve(result);
            }
          }
          // Real Setup preflight and post-write inference use the same local protocol route.
          writeOpenAiResponsesText(response, {
            text: "OK",
            messageId: randomUUID(),
            responseId: randomUUID(),
          });
        } catch (error) {
          failed.reject(error);
          response.destroy(error instanceof Error ? error : undefined);
        }
      },
    });
    const cfg = {
      ...createSubagentModelConfig(state.workspaceDir, {
        baseUrl: model.baseUrl + "/v1",
        modelId: "setup-application-proof",
        runtime: true,
      }),
      logging: {
        level: "debug" as const,
        consoleLevel: "silent" as const,
        file: state.path("gateway.log"),
      },
      skills: { load: { watch: false } },
      plugins: {
        enabled: true,
        allow: [PLUGIN],
        load: { paths: [pluginRoot] },
        slots: { memory: "none" },
        entries: { [PLUGIN]: { enabled: true, config: { value: "old" } } },
      },
      tools: { profile: "full" as const, codeMode: false, toolSearch: false },
      gateway: { controlUi: { enabled: false } },
    };
    await state.writeConfig(cfg);
    await seedInstalledPluginIndex(
      { [PLUGIN]: { source: "path", sourcePath: pluginRoot, installPath: pluginRoot } },
      { env: process.env, config: cfg },
    );
    await resolvePluginCapabilityConsent({
      config: cfg,
      pluginId: PLUGIN,
      env: process.env,
      acknowledge: {
        reviewToken: computeDeclaredSurfaceHash(
          resolvePluginArtifactDeclaredSurface(pluginRoot, process.env, { config: cfg }),
        ),
      },
    });
    stage("gateway-start");
    gateway = await startSetupProductGateway(state.configPath);
    stage("gateway-ready");
    const runId = randomUUID();
    await gateway.client.request("chat.send", {
      sessionKey: "agent:main:dashboard:" + randomUUID(),
      message: HOLD,
      idempotencyKey: runId,
      deliver: false,
    });
    await wait(held.promise);
    const record = getActivePluginRegistry()?.plugins.find((item) => item.id === PLUGIN);
    assert(record);
    const instance = getPluginInstance(record);
    assert(instance);
    expect(instance.retentionSnapshot().total).toBeGreaterThan(0);
    const sessionId = randomUUID();
    stage("setup-proposal");
    const proposal = await wait(
      gateway.client.request<{ reply: string }>("openclaw.chat", {
        sessionId,
        message: `config set plugins.entries.${PLUGIN}.config.value new`,
      }),
    );
    expect(proposal.reply).toContain("new");
    const diskValue = async () => {
      const disk = JSON.parse(await fs.readFile(state.configPath, "utf8")) as typeof cfg;
      return disk.plugins.entries[PLUGIN]?.config.value;
    };
    expect(await diskValue()).toBe("old");
    // The public Setup approval path applies exactly the pending proposal.
    stage("setup-approval");
    const approved = await wait(
      gateway.client.request<{ reply: string }>("openclaw.chat", { sessionId, message: "yes" }),
    );
    stage("setup-replied");
    await loggerTest.flushFileLogQueueForTests();
    const reloadLogs = await readConfiguredLogTail({ limit: 100, maxBytes: 128 * 1024 }, (line) =>
      /reload|plugin|config/i.test(line),
    );
    process.stderr.write(`SETUP_PRODUCT_RELOAD_LOGS ${JSON.stringify(reloadLogs.lines)}\n`);
    const evidence = JSON.stringify({
      approved,
      active: activeValue(),
      disk: await diskValue(),
      retention: instance.retentionSnapshot(),
      minimalGateway: process.env.OPENCLAW_TEST_MINIMAL_GATEWAY,
      reload: getRuntimeConfigSnapshot()?.gateway?.reload,
    });
    process.stderr.write(`SETUP_PRODUCT_OUTCOME ${evidence}\n`);
    expect(approved.reply, evidence).toContain("Saved; waiting to apply.");
    expect(approved.reply).not.toContain("Saved and applied to the active Gateway.");
    expect(await diskValue()).toBe("new");
    expect(activeValue()).toBe("old");
    expect(instance.retentionSnapshot().total).toBeGreaterThan(0);
    stage("release-held-turn");
    release.resolve();
    expect(
      await wait(gateway.client.request("agent.wait", { runId, timeoutMs: 30_000 })),
    ).toMatchObject({ status: "ok" });
    await wait(applied.promise);
    stage("runtime-applied");
    expect(activeValue()).toBe("new");
    expect(instance.retentionSnapshot().total).toBe(0);
    expect(gateway.starts, "Deferred application must not require a restart").toBe(1);
    const probeRunId = randomUUID();
    await gateway.client.request("chat.send", {
      sessionKey: "agent:main:dashboard:" + randomUUID(),
      message: PROBE,
      idempotencyKey: probeRunId,
      deliver: false,
    });
    expect(await wait(newValue.promise)).toEqual({ value: "new" });
    expect(
      await wait(gateway.client.request("agent.wait", { runId: probeRunId, timeoutMs: 30_000 })),
    ).toMatchObject({ status: "ok" });
  } finally {
    stage("cleanup");
    release.resolve();
    unwatch();
    await model?.close();
    if (gateway) {
      await gateway.stop();
    }
    await state.cleanup();
  }
});
