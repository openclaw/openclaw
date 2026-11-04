import { randomUUID } from "node:crypto";
import { json } from "node:stream/consumers";
import { afterEach, expect, it } from "vitest";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import { writeRestartToolCalls } from "./gateway-restart.test-support.js";
import { connectProofClient } from "./helpers/gateway-integration-fixtures.js";
import * as fixture from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { withinTest } from "./helpers/promise.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

it("a child spawned by a cron-root run continues and reports back after the parent returns", async ({
  signal,
}) => {
  const parentReturned = createDeferredCore();
  const reported = createDeferredCore();
  let childRunId: string | undefined;
  const childRequests: number[] = [];
  const call = (id: string, name: string, args: object) => [
    { type: "function_call", id, call_id: id, name, arguments: JSON.stringify(args) },
  ];
  const server = await fixture.startOpenAiResponsesModelServer({
    modelId: "child-lifetime",
    bindError: "model server did not bind",
    onRequest: async (request, response) => {
      const body = JSON.stringify(await json(request));
      const results = body.split('"function_call_output"').length - 1;
      const text = (id: string, value: string) =>
        writeOpenAiResponsesText(response, { text: value, messageId: `${id}_m`, responseId: id });
      if (body.includes("Spawn the worker.")) {
        if (body.includes("CHILD-DONE")) {
          reported.resolve();
          return text("r_report", "Worker reported.");
        }
        // The spawn result names the child's run, which the test waits on below.
        childRunId ??= /runId\\*":\s*\\*"([0-9a-f-]{36})/u.exec(
          body.split("childSessionKey")[1] ?? "",
        )?.[1];
        return results === 0
          ? writeRestartToolCalls(
              response,
              "r_spawn",
              call("c_spawn", "sessions_spawn", { task: "Worker task", mode: "run" }),
            )
          : text("r_parent", "Spawned.");
      }
      childRequests.push(results);
      // The child's next request starts only after the parent's run returned.
      await parentReturned.promise;
      return results === 0
        ? writeRestartToolCalls(response, "r_read", call("c_read", "read", { path: "absent.txt" }))
        : text("r_child", "CHILD-DONE");
    },
  });
  cleanup.push(server.close);
  const config = fixture.createOpenAiResponsesModelConfig({
    baseUrl: server.baseUrl,
    providerId: "child-lifetime",
    modelId: "child-lifetime",
    reasoning: false,
    toolProfile: "full",
  });
  // A stable cron root fences its own provider requests for the life of its run.
  const instance = await createOpenClawTestInstance({
    name: "gateway-cron-root-subagent-spawn",
    config: { ...config, tools: { ...config.tools, toolSearch: false } },
    env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
  });
  cleanup.push(instance.cleanup);
  await instance.startGateway();
  const client = await connectProofClient(instance, {
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write"],
  });
  cleanup.push(() => disconnectGatewayClient(client));
  const runId = randomUUID();
  const params = { sessionKey: "agent:main:cron:child-lifetime", message: "Spawn the worker." };
  await expect(
    client.request(
      "agent",
      { ...params, deliver: false, idempotencyKey: runId },
      { expectFinal: true },
    ),
  ).resolves.toMatchObject({ status: "ok", runId });
  parentReturned.resolve();
  // The child's own run settles first; on main it fails on the parent's closed fence.
  await expect(
    client.request("agent.wait", { runId: childRunId, timeoutMs: 60_000 }, { timeoutMs: 90_000 }),
  ).resolves.toMatchObject({ status: "ok" });
  await withinTest(reported.promise, signal);
  expect(childRequests).toEqual([0, 1]);
});
