// Compile the real Gateway and model runtime before the startup ordering deadline begins.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  loadExactSessionEntry,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry-replace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import {
  createProductState,
  productModelConfig,
  productProvider,
} from "./server.chat-product.test-support.js";
import * as systemTurnAuthority from "./session-system-turn-authority.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it("serves startup reads and unrelated turns while a resumed session retains input ordering", async ({
  signal,
  onTestFailed,
}) => {
  let stage = "fixture";
  onTestFailed(() => {
    process.stderr.write(`startup resume regression stopped at ${stage}\n`);
  });
  const state = await createProductState("startup-resume-ordering");
  const resumeKey = "agent:main:startup-resuming";
  const healthyKey = "agent:main:startup-healthy";
  const entered = createDeferred();
  const release = createDeferred();
  const observed = {
    healthy: createDeferred(),
    resume: createDeferred(),
    fresh: createDeferred(),
  };
  const calls: string[] = [];
  const errors: unknown[] = [];
  const providerServer = productProvider(errors, (body, response) => {
    const input: unknown = JSON.parse(body);
    const messages = isRecord(input) && Array.isArray(input.input) ? input.input : [];
    const current = JSON.stringify(
      messages.findLast((message) => {
        if (!isRecord(message) || message.role !== "user") {
          return false;
        }
        const text = JSON.stringify(message);
        return (
          text.includes("FRESH_DURING_RESUME") ||
          text.includes("HEALTHY_DURING_RESUME") ||
          text.includes("The Gateway restarted while you were working.")
        );
      }),
    );
    const kind = current?.includes("FRESH_DURING_RESUME")
      ? "fresh"
      : current?.includes("HEALTHY_DURING_RESUME")
        ? "healthy"
        : current?.includes("The Gateway restarted while you were working.")
          ? "resume"
          : undefined;
    if (kind) {
      calls.push(kind);
      observed[kind].resolve();
    }
    writeOpenAiResponsesText(response, {
      text: "Synthetic startup reply.",
      responseId: `response-${calls.length}`,
      messageId: `message-${calls.length}`,
    });
  });
  const prepareAuthority = systemTurnAuthority.prepareSessionSystemTurnAuthority;
  using heldResume = vi
    .spyOn(systemTurnAuthority, "prepareSessionSystemTurnAuthority")
    .mockImplementation(async (params) => {
      if (params.sessionKey === resumeKey) {
        entered.resolve();
        await release.promise;
      }
      return prepareAuthority(params);
    });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined = undefined;
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => state.cleanup());
  cleanup.defer(() => closeProvider(providerServer));
  cleanup.defer(async () => {
    release.resolve();
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close();
    }
  });
  signal.addEventListener("abort", () => release.resolve(), { once: true });
  const provider = buildMockOpenAiResponsesProvider(
    await listenProvider(providerServer),
    "startup",
  );
  const model = productModelConfig(state.workspaceDir, provider);
  const cfg = {
    cron: { enabled: false },
    agents: { defaults: model.defaults, entries: { main: {} } },
    models: model.models,
    plugins: { slots: { memory: "none" } },
    tools: { profile: "minimal" },
    messages: { queue: { mode: "followup" } },
    gateway: { auth: { mode: "token", token: "synthetic-startup-token" } },
  } satisfies OpenClawConfig;
  await state.writeConfig(cfg);
  for (const sessionKey of [resumeKey, healthyKey]) {
    replaceSessionEntrySync(
      { agentId: "main", sessionKey },
      {
        sessionId: sessionKey.endsWith("resuming") ? "resuming-session" : "healthy-session",
        updatedAt: Date.now(),
      },
    );
  }
  const target = { agentId: "main", sessionKey: resumeKey };
  replaceSessionEntrySync(target, {
    ...loadExactSessionEntry(target)!.entry,
    resumeAfterRestart: { queuedInputIds: [] },
  });
  expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toBeDefined();
  stage = "gateway startup";
  gateway = await startGatewayWithClient({
    cfg,
    configPath: state.configPath,
    token: "synthetic-startup-token",
    scopes: ["operator.admin"],
    sidecarStartup: "defer",
  });
  stage = "resume admission";
  await withinTest(entered.promise, signal);
  expect(heldResume).toHaveBeenCalled();
  stage = "readiness and reads";
  const ready = await fetch(`http://127.0.0.1:${gateway.port}/readyz`, { signal });
  expect(ready.status).toBe(200);
  expect(await ready.json()).toMatchObject({ ready: true });
  for (const [method, params] of [
    ["models.list", { agentId: "main" }],
    ["mentions.list", {}],
    ["sessions.github.options", { sessionKey: resumeKey, agentId: "main" }],
  ] as const) {
    await gateway.client.request(method, params, { timeoutMs: 5_000 });
  }
  const send = (sessionKey: string, message: string) =>
    gateway!.client.request<{ runId: string }>("chat.send", {
      sessionKey,
      message,
      idempotencyKey: message,
    });
  const fresh = send(resumeKey, "FRESH_DURING_RESUME");
  void fresh.catch(() => {});
  stage = "unrelated acceptance";
  const healthy = await send(healthyKey, "HEALTHY_DURING_RESUME");
  stage = "unrelated model input";
  const waitForRun = (runId: string) =>
    gateway!.client.request("agent.wait", { runId, timeoutMs: 10_000 });
  const healthyRun = waitForRun(healthy.runId);
  await withinTest(observed.healthy.promise, signal);
  expect(calls).toEqual(["healthy"]);
  const transcript = { agentId: "main", sessionKey: resumeKey, sessionId: "resuming-session" };
  expect(JSON.stringify(await loadTranscriptEvents(transcript))).not.toContain(
    "FRESH_DURING_RESUME",
  );
  release.resolve();
  stage = "resuming session acceptance";
  const resumed = await fresh;
  stage = "fresh model input";
  await withinTest(observed.fresh.promise, signal);
  expect(calls).toEqual(["healthy", "resume", "fresh"]);
  for (const result of [healthyRun, waitForRun(resumed.runId)]) {
    expect(await result).toMatchObject({
      status: "ok",
    });
  }
  const inputs = (await loadTranscriptEvents(transcript)).flatMap((event) =>
    isRecord(event) && isRecord(event.message) && event.message.role === "user"
      ? [JSON.stringify(event.message)]
      : [],
  );
  expect(
    inputs.some((input) => input.includes("The Gateway restarted while you were working.")),
  ).toBe(true);
  expect(inputs.findIndex((input) => input.includes("FRESH_DURING_RESUME"))).toBeGreaterThan(
    inputs.findIndex((input) => input.includes("The Gateway restarted while you were working.")),
  );
  expect(errors).toEqual([]);
});
