import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import * as configRunner from "../cli/config-cli-runner.js";
import { selectLiveRuntimeConfig } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeProvider,
  listenProvider,
  writeToolCall,
} from "./gateway-provider-fixture.test-support.js";
import {
  createProductState,
  productModelConfig,
  productProvider,
} from "./server.chat-product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it(
  "rechecks standing delegation authority at the real config writer during delegated-change preparation",
  { timeout: 90_000 },
  async () => {
    const state = await createProductState("delegation-persistent-revocation");
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => state.cleanup());
    const errors: unknown[] = [];
    const replies: string[] = [];
    let value = "warn";
    const provider = productProvider(errors, (raw, response) => {
      const body: unknown = JSON.parse(raw);
      if (!isRecord(body)) {
        throw new Error("Expected a Responses request object");
      }
      const tools = (Array.isArray(body.tools) ? body.tools : []).filter(isRecord);
      const tool = tools.find((entry) => entry.name === "openclaw");
      const parameters = isRecord(tool?.parameters) ? tool.parameters : {};
      const properties = isRecord(parameters.properties) ? parameters.properties : {};
      const regular = "message" in properties;
      const system = "action" in properties;
      const input = (Array.isArray(body.input) ? body.input : []).filter(isRecord);
      const output = input.findLast((item) => item.type === "function_call_output");
      if ((regular || system) && !output) {
        if (regular) {
          expect(tools.map((entry) => entry.name)).toEqual(["openclaw"]);
        }
        writeToolCall(
          response,
          "openclaw",
          regular
            ? { message: `Set logging.level to ${value}.` }
            : { action: "config_set", path: "logging.level", value },
        );
      } else {
        if (regular && output) {
          replies.push(String(output.output));
        }
        writeOpenAiResponsesText(response, {
          text: "DELEGATION_DONE",
          messageId: randomUUID(),
          responseId: randomUUID(),
        });
      }
    });
    cleanup.defer(() => closeProvider(provider));
    const model = buildMockOpenAiResponsesProvider(await listenProvider(provider), "revocation");
    const { defaults, models } = productModelConfig(state.workspaceDir, model);
    const cfg = {
      logging: { level: "info" },
      agents: {
        defaults,
        entries: { main: { tools: { openclaw: { autoApproveChanges: true } } } },
      },
      models,
      plugins: { enabled: false, slots: { memory: "none" } },
      tools: { allow: ["openclaw"], codeMode: { enabled: false }, toolSearch: false },
      gateway: {
        mode: "local",
        auth: { mode: "token", token: "synthetic-delegation-revocation" },
        reload: { mode: "hybrid" },
      },
    } satisfies OpenClawConfig;
    const hotReloadRecovery = vi.fn(() => {
      throw new Error("Unexpected recovery restart during policy reload");
    });
    const gateway = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token: "synthetic-delegation-revocation",
      scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
      hotReloadRecovery,
    });
    cleanup.defer(async () => {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "delegation revocation proof complete" });
    });
    await gateway.server.startupSettled;
    const client = gateway.client;
    const readConfig = async (): Promise<OpenClawConfig> =>
      JSON.parse(await fs.readFile(state.configPath, "utf8"));

    // Hold only the handoff from parsed CLI input to asynchronous write
    // preparation. Both cases run the unchanged engine, policy owner, and writer.
    // Revoke before the writer reads its base so a stale hash cannot mask a
    // missing authority check.
    const runConfigOperations = configRunner.runConfigOperations;
    for (const revoke of [false, true]) {
      const entered = createDeferred();
      const resume = createDeferred();
      value = revoke ? "error" : "warn";
      using _ = vi.spyOn(configRunner, "runConfigOperations").mockImplementation(async (params) => {
        if (
          params.operations.some(
            (operation) => operation.requestedPath.join(".") === "logging.level",
          )
        ) {
          expect(params.beforePersistentApply).toBeTypeOf("function");
          entered.resolve();
          await resume.promise;
        }
        return runConfigOperations(params);
      });
      const before = await readConfig();
      const run = await client.request<{ runId: string }>("chat.send", {
        sessionKey: `agent:main:delegation-revoke-${randomUUID()}`,
        message: `Set logging.level to ${value}.`,
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      const terminal = client.request<{ status: string }>(
        "agent.wait",
        { runId: run.runId, timeoutMs: 60_000 },
        { timeoutMs: 65_000 },
      );
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          terminal,
          "write preparation was not reached",
        );
        expect(await readConfig()).toEqual(before);
        if (revoke) {
          const current = await client.request<{ hash: string }>("config.get", {});
          await client.request("config.patch", {
            baseHash: current.hash,
            raw: JSON.stringify({
              agents: { entries: { main: { tools: { openclaw: { autoApproveChanges: false } } } } },
            }),
          });
          await vi.waitFor(() =>
            expect(
              selectLiveRuntimeConfig()?.agents?.entries?.main?.tools?.openclaw?.autoApproveChanges,
            ).toBe(false),
          );
          expect((await readConfig()).logging?.level).toBe("warn");
        }
        const beforeResume = await fs.readFile(state.configPath, "utf8");
        resume.resolve();
        expect(await terminal).toMatchObject({ status: "ok" });
        expect(hotReloadRecovery).not.toHaveBeenCalled();
        expect(errors).toEqual([]);
        if (revoke) {
          expect((await readConfig()).logging?.level).toBe("warn");
          expect(replies.at(-1)).toContain("effective autoApproveChanges policy is false");
          expect(replies.at(-1)).not.toContain("Updated logging.level");
          expect(await fs.readFile(state.configPath, "utf8")).toBe(beforeResume);
        } else {
          expect(replies.at(-1)).toContain("Updated logging.level");
          expect((await readConfig()).logging?.level).toBe("warn");
        }
      } finally {
        resume.resolve();
        await terminal;
      }
    }
  },
);
