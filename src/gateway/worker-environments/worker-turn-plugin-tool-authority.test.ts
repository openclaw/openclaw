import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { acquireAgentRunPreparedModelRuntime } from "../../agents/prepared-model-runtime.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { getPluginInstance } from "../../plugins/plugin-instance-scope.js";
import * as worker from "./worker-turn-launcher.test-support.js";

beforeEach(worker.setupWorkerTurnLauncherTest);
afterEach(worker.cleanupWorkerTurnLauncherTest);

const TOOL_NAME = "authority_probe";
const probeKey = "__openclawWorkerPluginToolAuthorityProbe";

it("gives version-2 plugin tools live worker-turn invocation authority", async () => {
  await worker.seedActivePlacement();
  const input = worker.turn("plugin-tool-authority");
  const pluginId = "worker-authority-probe";
  const pluginDir = path.join(input.workspaceDir, pluginId);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      configSchema: { type: "object" },
      contracts: { tools: [TOOL_NAME] },
    }),
  );
  const pluginEntry = path.join(pluginDir, "index.cjs");
  // The factory context, not the tool body, owns invocation authority.
  await writeFile(
    pluginEntry,
    `module.exports = {
  id: "${pluginId}",
  register(api) {
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => ({
          name: "${TOOL_NAME}",
          label: "${TOOL_NAME}",
          description: "Records an authorized effect",
          parameters: { type: "object", properties: {} },
          async execute() {
            context.assertInvocationCurrent();
            globalThis.${probeKey}();
            return { content: [{ type: "text", text: "effect recorded" }], details: {} };
          },
        }),
      },
      { name: "${TOOL_NAME}" },
    );
  },
};`,
  );
  const effects = vi.fn();
  Object.assign(globalThis, { [probeKey]: effects });
  const config = {
    ...input.config,
    plugins: { load: { paths: [pluginEntry] }, entries: { [pluginId]: { enabled: true } } },
  };
  await using runtime = await acquireAgentRunPreparedModelRuntime({
    config,
    agentId: input.agentId,
    agentDir: resolveAgentDir(config, input.agentId),
    workspaceDir: input.workspaceDir,
  });
  const record = runtime.snapshot.pluginRegistry?.plugins.find((plugin) => plugin.id === pluginId);
  assert(record?.status === "loaded");
  let retained: AnyAgentTool | undefined;
  const completed = new Error("synthetic worker proof complete");
  const tunnel = worker.createWorkerTurnTunnel({
    launchTurn: async () => {
      assert(retained);
      await expect(retained.execute("live-call", {})).resolves.toMatchObject({
        content: [{ type: "text", text: "effect recorded" }],
      });
      throw completed;
    },
    runWorkspaceCommand: vi.fn(),
    syncWorkspace: vi.fn(),
    reconcileWorkspace: vi.fn(worker.reconcileUnchangedLocalWorkspace),
    stop: vi.fn(),
  });
  const provider = worker.createWorkerSessionTurnPlacementProvider({
    placements: worker.placements,
    environments: {
      ...worker.unusedEnvironments(),
      get: worker.attachedEnvironment,
      acquireTurnCredential: async () => worker.credential(),
      startTunnel: async () => tunnel,
      createGatewayTools: async ({ prepareTools }) => {
        const tools = (await prepareTools?.([])) ?? [];
        retained = tools.find((tool) => tool.name === TOOL_NAME);
        return tools;
      },
    },
  });
  try {
    await expect(
      provider.executeTurn(
        { ...worker.sessionTarget, runId: input.runId },
        { ...input, config, pluginGeneration: runtime.pluginGeneration },
        vi.fn(),
      ),
    ).rejects.toBe(completed);
    expect(effects).toHaveBeenCalledOnce();
    // The retained tool must not outlive the turn claim that admitted it.
    const late = await retained!.execute("late-call", {}).then(
      () => "executed",
      (error: unknown) => `refused (${error instanceof Error ? error.message : String(error)})`,
    );
    console.info(
      `[worker-authority] turn:live → call:ok → turn:closed → late call ${late}; effects: ${effects.mock.calls.length}`,
    );
    expect(late).toMatch(/^refused/);
    expect(effects).toHaveBeenCalledOnce();
  } finally {
    Reflect.deleteProperty(globalThis, probeKey);
    input.preparedRunAdmission.close();
    await runtime[Symbol.asyncDispose]();
    await getPluginInstance(record)?.dispose();
  }
});
