const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { DatabaseSync } = require("node:sqlite");
const { resolvePluginProviders } = require("openclaw/plugin-sdk/provider-catalog-runtime");

const ID = "mcp-registration-fixture";
const TOOL = "mcp_native_hold";
const emit = (phase, extra = {}) =>
  process.stderr.write(`MCP_OWNERSHIP_PROOF ${JSON.stringify({ phase, ...extra })}\n`);

module.exports = {
  id: ID,
  name: "Native MCP registration fixture",
  register(api) {
    if (!["full", "discovery", "tool-discovery"].includes(api.registrationMode)) {
      throw new Error(`Unsupported fixture registration mode: ${api.registrationMode}`);
    }
    const { databasePath, gateDir, workspaceDir, nestedStages = [] } = api.pluginConfig;
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, phase TEXT NOT NULL)",
    );
    const record = (phase) => database.prepare("INSERT INTO events (phase) VALUES (?)").run(phase);
    const waitForGate = async (name) => {
      const target = path.join(gateDir, name);
      // Observe the durable gate itself; file-watch notifications can be missed.
      while (!fs.existsSync(target)) {
        await delay(50);
      }
    };
    const provider = {
      id: ID,
      label: "Native MCP provider fixture",
      auth: [],
      isCacheTtlEligible(context) {
        record(`sdk:${context.modelId}`);
        return database.prepare("SELECT 42 AS value").get().value === 42;
      },
    };
    const probeSdk = (stage) => {
      if (!nestedStages.includes(stage)) {
        return;
      }
      const selected = resolvePluginProviders({
        config: api.config,
        env: process.env,
        onlyPluginIds: [ID],
        workspaceDir,
        registryScope: "loaded",
      }).find((entry) => entry.id === ID);
      if (!selected || selected.isCacheTtlEligible({ provider: ID, modelId: stage }) !== true) {
        throw new Error(`Nested SDK provider lookup failed at ${stage}`);
      }
      emit(`sdk:${stage}`);
    };
    api.registerProvider(provider);
    api.lifecycle.registerRuntimeLifecycle({
      id: "native-database",
      cleanup() {
        record("semantic-cleanup");
        emit("semantic-cleanup");
      },
      async dispose() {
        record("dispose-entered");
        emit("dispose-entered", { databaseOpen: database.isOpen });
        await waitForGate("dispose.release");
        record("dispose-completed");
        database.close();
        emit("disposed", { databaseOpen: database.isOpen });
      },
    });
    if (nestedStages.includes("harness")) {
      api.registerAgentHarness({
        id: "mcp-registration-fixture-harness",
        label: "Native MCP cleanup fixture",
        supports: () => ({ supported: false }),
        runAttempt: async () => {
          throw new Error("The fixture harness must not execute a model");
        },
        dispose: async () => {
          probeSdk("harness");
          record("harness-disposed");
          emit("harness-disposed");
        },
      });
    }
    api.registerTool(
      () => {
        probeSdk("factory");
        return {
          name: TOOL,
          label: "Hold a native SQLite operation",
          description: "Synthetic ownership proof",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute(_callId, _params, signal) {
            probeSdk("handler");
            record("tool-entered");
            signal.addEventListener(
              "abort",
              () => {
                probeSdk("abort");
                record("request-aborted");
                emit("request-aborted", { databaseOpen: database.isOpen });
              },
              { once: true },
            );
            const gate = waitForGate("tool.release");
            emit("tool-entered");
            await gate;
            record("tool-written");
            emit("tool-written");
            return { content: [{ type: "text", text: "native write completed" }], details: {} };
          },
        };
      },
      { names: [TOOL] },
    );
    record("registered");
    emit("registered", { registrationMode: api.registrationMode });
  },
};
