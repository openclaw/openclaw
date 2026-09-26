/** Manual joined boundary proof. Deterministic providers, NOT live-provider evidence.
 * No routing/receipt owner is replaced. Run after a clean canonical build,
 * using the normal proxy policy and a loopback-capable isolated test runner.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import {
  GatewayFrameSchema,
  type GatewayFrame,
  type RequestFrame,
} from "../../../packages/gateway-protocol/src/schema/frames.ts";
import {
  ChatEventSchema,
  ChatInputReceiptsSchema,
  ChatPendingInputsPageSchema,
  ChatSendParamsSchema,
  type ChatEvent,
} from "../../../packages/gateway-protocol/src/schema/logs-chat.ts";
import { validateDecisionBatch } from "../../../src/decisions/validation.ts";
import type { PluginHookInputRouteEvent } from "../../../src/plugins/hook-message.types.ts";
import { assertUiE2ePreflight } from "../../../test/vitest/vitest.ui-e2e-preflight.ts";
import type { ChatHistoryResult } from "../../../ui/src/pages/chat/chat-history-snapshot.ts";
import type { DecisionObservation } from "./auto-steer-decision-provider.mts";

const root = process.cwd();
await fs.mkdir(path.join(root, ".openclaw/tmp"), { recursive: true });
const artifact = await fs.mkdtemp(path.join(root, ".openclaw/tmp/auto-joined-run-"));
const proof: Record<string, unknown> = {
  kind: "Control UI -> isolated Gateway -> builtin auto-steer -> DecisionSDK -> native custody",
  qualification:
    "DETERMINISTIC PROVIDER BOUNDARY PROOF; NOT LIVE-PROVIDER/REAL-AGENT QUALITY EVIDENCE",
  passed: false,
  stage: "preflight",
};
const write = (name: string, value: unknown) =>
  fs.writeFile(path.join(artifact, name), JSON.stringify(value, null, 2) + "\n");
let instance:
  | Awaited<
      ReturnType<
        typeof import("../../../test/helpers/openclaw-test-instance.ts").createOpenClawTestInstance
      >
    >
  | undefined;
let browser: import("playwright").Browser | undefined;
let provider: ReturnType<typeof createServer> | undefined;
const providerHandlers = new Set<Promise<void>>();
const bus = new EventEmitter();
const frames: Array<{ direction: "sent" | "received"; frame: GatewayFrame }> = [];
const chatSends: Array<RequestFrame & { params: Static<typeof ChatSendParamsSchema> }> = [];
const chatEvents: ChatEvent[] = [];
// sessions.changed preserves the backing runId and its clientRunId mapping;
// agent events remap runId to the client identity in server-chat.ts.
const runStarts: Array<{ runId: string; clientRunId: string }> = [];
const providerBodies: Array<{
  body: { model: string; input: unknown[] };
  response: import("node:http").ServerResponse;
}> = [];
const sessionKey = "agent:main:auto-joined-proof";
const pending = new Map<string, string>();
const firstText = "Write a CSV parser. Keep the current task active while I add a requirement.";
const correction = "Also handle escaped commas in that CSV parser.";
const finalText = "Synthetic backend observed the escaped-comma requirement in its next request.";
let browserFault = false;
let providerFault: string | undefined;
let observationFault = false;
const originalTmpdir = process.env.TMPDIR;
function jsonRecord(text: string): Record<string, unknown> {
  const value = safeParseJson(text);
  assert(isRecord(value), "Expected a JSON object observation");
  return value;
}
function routeEvidence(value: unknown): PluginHookInputRouteEvent {
  assert(isRecord(value));
  const { currentTurn, newMessage } = value;
  assert(Array.isArray(currentTurn));
  assert(typeof newMessage === "string");
  return {
    newMessage,
    currentTurn: currentTurn.map((message: unknown) => {
      assert(isRecord(message));
      const { role, text } = message;
      assert(role === "user" || role === "assistant");
      assert(typeof text === "string");
      return { role, text };
    }),
  };
}
function decisionObservation(line: string): DecisionObservation {
  const { batch, model, agentId } = jsonRecord(line);
  assert(validateDecisionBatch(batch));
  assert(typeof model === "string");
  assert(agentId === undefined || typeof agentId === "string");
  return { batch, model, agentId };
}
async function waitUntil(check: () => unknown, label: string, timeoutMs = 20_000) {
  const observed = () => {
    assert.equal(providerFault, undefined);
    assert.equal(browserFault, false);
    assert.equal(observationFault, false, "Invalid Gateway observation");
    return check();
  };
  if (observed()) {
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    while (!observed()) {
      await once(bus, "change", { signal: controller.signal });
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }
    throw new Error("Timed out awaiting " + label, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}
function changed() {
  bus.emit("change");
}
try {
  // Same preflight owner as the GUI suite; never alter proxy variables or dispatchers.
  await assertUiE2ePreflight();
  proof.stage = "matched-build";
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  proof.head = head;
  const trackedChanges = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  });
  assert.equal(
    trackedChanges,
    "",
    "Finish the lead-owned merge and canonical build first; this harness never commits/builds.",
  );
  for (const name of [".buildstamp", ".runtime-postbuildstamp"]) {
    const stamp = jsonRecord(await fs.readFile(path.join(root, "dist", name), "utf8"));
    assert.equal(stamp.head, head, "Refuse a stale runtime: " + name);
    assert.equal(stamp.inputsClean, true, "Refuse outputs from unidentified dirty inputs: " + name);
    proof[name] = stamp;
  }
  await Promise.all([fs.access("dist/index.js"), fs.access("dist/control-ui/index.html")]);
  const { createOpenClawTestInstance } =
    await import("../../../test/helpers/openclaw-test-instance.ts");
  const { chromium } = await import("playwright");
  const { resolvePlaywrightChromiumExecutablePath } =
    await import("../../../ui/src/test-helpers/control-ui-e2e.ts");
  const { waitForControlUiGatewayReady } =
    await import("../../../ui/src/test-helpers/control-ui-e2e-readiness.ts");
  const { writeOpenAiResponsesText } =
    await import("../../../test/helpers/openai-responses-sse.ts");
  proof.stage = "fixture";
  const pluginDir = path.join(artifact, "decision-fixture");
  await fs.mkdir(pluginDir);
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "auto-joined-decision",
      name: "Joined proof deterministic Decision provider",
      activation: { onStartup: true },
      contracts: { decisionProviders: ["auto-joined-decision"] },
      configSchema: {
        type: "object",
        additionalProperties: false,
        required: ["evidencePath"],
        properties: { evidencePath: { type: "string" } },
      },
    }),
  );
  // Only the model-boundary answer is synthetic. The actual bundled input_route
  // adviser remains the sole consumer, with host Decision validation/lifetime.
  await fs.copyFile(
    path.join(root, "test/e2e/qa-lab/auto-steer-decision-provider.mts"),
    path.join(pluginDir, "index.ts"),
  );
  provider = createServer((request, response) => {
    const handler = (async () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const { model, input } = jsonRecord(Buffer.concat(chunks).toString("utf8"));
      assert(typeof model === "string");
      assert.equal(model, "echo", "Only the synthetic backend model may run");
      assert(Array.isArray(input));
      providerBodies.push({ body: { model, input }, response });
      if (providerBodies.length > 2) {
        throw new Error("Unexpected third backend request");
      }
      changed();
      // Both calls stay held until explicit observations below; no fixed sleeps.
    })().catch((error: unknown) => {
      providerFault = error instanceof Error ? error.message : "backend fixture failed";
      response.destroy();
      changed();
    });
    providerHandlers.add(handler);
    void handler.then(() => providerHandlers.delete(handler));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  assert(address && typeof address !== "string");
  // Fixture temp/state stays in this invocation; only Chromium gets short TMPDIR.
  const temp = path.join(artifact, "temp");
  await fs.mkdir(temp);
  process.env.TMPDIR = temp;
  instance = await createOpenClawTestInstance({
    name: "auto-joined",
    state: { prefix: "auto-joined-state-" },
    env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
    config: {
      gateway: { controlUi: { enabled: true } },
      cron: { enabled: false },
      agents: {
        ownership: "explicit",
        entries: { main: { identity: { name: "Synthetic joined proof" } } },
        defaults: {
          model: "auto-joined-backend/echo",
          decisionModel: "auto-joined-decision/fixed",
          modelPolicy: { allow: ["auto-joined-backend/*", "auto-joined-decision/*"] },
          experimental: { decisionAssistance: true },
        },
      },
      messages: { queue: { mode: "followup" } },
      models: {
        catalogRefresh: { enabled: false },
        providers: {
          "auto-joined-backend": {
            api: "openai-responses",
            apiKey: "synthetic-joined-test-only",
            baseUrl: "http://127.0.0.1:" + address.port + "/v1",
            models: [{ id: "echo", name: "Synthetic held backend" }],
          },
        },
      },
      plugins: {
        allow: ["auto-steer", "auto-joined-decision", "openai"],
        load: { paths: [pluginDir] },
        entries: {
          "auto-steer": { enabled: true },
          "auto-joined-decision": {
            enabled: true,
            config: { evidencePath: path.join(pluginDir, "evaluations.jsonl") },
          },
        },
        slots: { memory: "none" },
      },
    },
  });
  await instance.startGateway();
  const call = async (method: string, params: object) => {
    const result = await instance!.cli([
      "gateway",
      "call",
      method,
      "--json",
      "--params",
      JSON.stringify(params),
    ]);
    assert.equal(result.code, 0, method + " failed (inspect private Gateway logs)");
    return jsonRecord(result.stdout);
  };
  await call("sessions.create", { key: sessionKey, agentId: "main", label: "Joined Auto proof" });
  const handoff = await instance.cli(["dashboard", "--json"]);
  assert.equal(handoff.code, 0, "dashboard bootstrap failed");
  const { browserUrl } = jsonRecord(handoff.stdout);
  assert(typeof browserUrl === "string");
  const url = new URL(browserUrl);
  url.pathname = "/chat/main/auto-joined-proof";
  url.search = "";
  browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    env: { ...process.env, TMPDIR: "/var/tmp" },
  });
  const context = await browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.addInitScript(() =>
    localStorage.setItem(
      "openclaw:control-ui:community-invite",
      JSON.stringify({ dismissedAtMs: 1770000000000 }),
    ),
  );
  page.on("pageerror", () => {
    browserFault = true;
    changed();
  });
  const captureFrame = (direction: "sent" | "received", payload: string | Buffer) => {
    try {
      const frame = safeParseJson(payload.toString());
      assert(Value.Check(GatewayFrameSchema, frame));
      if (frame.type === "req") {
        pending.set(frame.id, frame.method);
        if (frame.method === "connect") {
          return;
        }
        if (direction === "sent" && frame.method === "chat.send") {
          assert(Value.Check(ChatSendParamsSchema, frame.params));
          chatSends.push({ ...frame, params: frame.params });
        }
      }
      if (frame.type === "res" && pending.get(frame.id) === "connect") {
        return;
      }
      if (frame.type === "event") {
        if (frame.event === "connect.challenge") {
          return;
        }
        if (frame.event === "chat") {
          assert(Value.Check(ChatEventSchema, frame.payload));
          chatEvents.push(frame.payload);
        }
        if (frame.event === "sessions.changed") {
          const event = asOptionalRecord(frame.payload);
          if (event?.sessionKey === sessionKey && event.phase === "start") {
            const { runId, clientRunId } = event;
            assert(typeof runId === "string");
            assert(clientRunId === undefined || typeof clientRunId === "string");
            runStarts.push({ runId, clientRunId: clientRunId ?? runId });
          }
        }
      }
      frames.push({ direction, frame });
    } catch {
      observationFault = true;
    } finally {
      changed();
    }
  };
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => captureFrame("sent", payload));
    socket.on("framereceived", ({ payload }) => captureFrame("received", payload));
  });
  proof.stage = "ui-bootstrap";
  await page.goto(url.href); // Authentication-bearing URL is never written to evidence.
  await waitForControlUiGatewayReady(page);
  // Bind evidence to the bundle the real Gateway actually served.
  const assets = await page
    .locator('script[type="module"][src]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")!));
  assert(assets.length);
  const served = [];
  for (const asset of assets) {
    const location = new URL(asset, url);
    assert.equal(location.origin, url.origin);
    assert(location.pathname.startsWith("/assets/"));
    const response = await page.request.get(location.href);
    assert.equal(response.status(), 200);
    const bytes = await response.body();
    assert(
      bytes.equals(
        await fs.readFile(path.join(root, "dist/control-ui", location.pathname.slice(1))),
      ),
    );
    served.push({
      asset: location.pathname,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  proof.served = served;
  const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
  const composer = pane.getByRole("textbox", { name: "Chat composer", exact: true });
  await composer.waitFor();
  const sends = () => chatSends;
  const reply = (id: string) => {
    const frame = frames.find(
      (row) => row.direction === "received" && row.frame.type === "res" && row.frame.id === id,
    )?.frame;
    return frame?.type === "res" ? frame : undefined;
  };
  const terminal = (id: string) =>
    chatEvents.find(
      (event) =>
        event.sessionKey === sessionKey &&
        event.runId === id &&
        ["final", "error", "aborted"].includes(event.state),
    );
  const history = async () => {
    const sessionId = sends()[0]?.params.sessionId;
    assert(typeof sessionId === "string" && sessionId.length > 0);
    // sessionId is an anchored-message selector on this wire contract.
    // Read current history by key, then reject any physical-session mismatch.
    const result = await call("chat.history", {
      sessionKey,
      limit: 50,
      inputRunIds: sends().map((frame) => frame.params.idempotencyKey),
    });
    assert.equal(result.sessionId, sessionId);
    const { messages, pendingInputs, inputReceipts } = result;
    assert(Array.isArray(messages));
    assert(Value.Check(ChatPendingInputsPageSchema, pendingInputs));
    assert(Value.Check(ChatInputReceiptsSchema, inputReceipts));
    const observation: Required<
      Pick<ChatHistoryResult, "messages" | "pendingInputs" | "inputReceipts">
    > = {
      messages,
      pendingInputs,
      inputReceipts,
    };
    return observation;
  };
  proof.stage = "first-turn";
  await page.waitForFunction(
    () =>
      document.querySelector("[data-chat-thinking-select]")?.getAttribute("aria-disabled") ===
      "false",
  );
  await pane.locator("[data-chat-thinking-select]").click();
  assert.equal(
    await pane.locator("[data-chat-auto-steer-toggle]").getAttribute("aria-checked"),
    "false",
  );
  await page.keyboard.press("Escape");
  await composer.fill(firstText);
  await composer.press("Enter");
  await waitUntil(
    () => sends().length === 1 && providerBodies.length === 1,
    "first real active backend call",
  );
  const first = sends()[0];
  assert(first);
  assert.equal(first.params.deliveryPolicy, undefined);
  assert.equal(first.params.sessionKey, sessionKey);
  const starts = () => runStarts.map((event) => event.runId);
  await waitUntil(
    () => starts().length > 0 && reply(first.id),
    "observed backing run lifecycle start and ACK",
  );
  assert(runStarts.every((event) => event.clientRunId === first.params.idempotencyKey));
  assert.equal(reply(first.id)?.ok, true);
  assert.equal(terminal(first.params.idempotencyKey), undefined);
  proof.stage = "auto-submit";
  await pane.locator("[data-chat-thinking-select]").click();
  const auto = pane.locator("[data-chat-auto-steer-toggle]");
  await auto.focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(
    () =>
      document.querySelector("[data-chat-auto-steer-toggle]")?.getAttribute("aria-checked") ===
      "true",
  );
  await page.keyboard.press("Escape");
  await composer.fill(correction);
  await composer.press("Enter");
  await waitUntil(() => {
    const send = sends()[1];
    return sends().length === 2 && send && reply(send.id);
  }, "Auto chat.send acknowledgement");
  const follow = sends()[1];
  assert(follow);
  assert.equal(follow.params.deliveryPolicy, "auto");
  assert.equal(
    follow.params.queueMode,
    undefined,
    "Inherited server baseline must stay unset on the wire",
  );
  assert.equal(follow.params.message, correction);
  const followReply = reply(follow.id);
  assert(followReply);
  assert.equal(followReply.ok, true);
  assert(isRecord(followReply.payload));
  assert.equal(followReply.payload.status, "started");
  assert.equal(followReply.payload.runId, follow.params.idempotencyKey);
  assert.equal(follow.params.sessionId, first.params.sessionId);
  assert.equal(providerBodies.length, 1);
  assert.equal(terminal(first.params.idempotencyKey), undefined);
  const pendingHistory = await history();
  await write("pending-history.json", pendingHistory);
  const queued = pendingHistory.pendingInputs.items.find(
    (entry) => entry.runId === follow.params.idempotencyKey,
  );
  assert(queued, "Gateway pending-input custody must exist while original provider is held");
  assert.equal(
    pendingHistory.inputReceipts.find((receipt) => receipt.runId === follow.params.idempotencyKey)
      ?.state,
    "pending",
  );
  assert(isRecord(queued.message));
  const pendingMetadata = asOptionalRecord(queued.message["__openclaw"]);
  assert(pendingMetadata);
  assert.deepEqual(pendingMetadata.autoSteer, { choice: "steer", reason: "decision" });
  assert.equal(pendingMetadata.steerTargetRunId, undefined, "advice is not a consumption receipt");
  const decisionRows = (await fs.readFile(path.join(pluginDir, "evaluations.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(decisionObservation);
  assert.equal(decisionRows.length, 1);
  const decision = decisionRows[0];
  assert(decision);
  assert.equal(decision.model, "fixed");
  assert.equal(decision.agentId, "main");
  const evidence = routeEvidence(decision.batch.state);
  assert.equal(evidence.newMessage, correction);
  assert(
    evidence.currentTurn.some(
      (message) => message.role === "user" && message.text.includes("CSV parser"),
    ),
  );
  const delivery = decision.batch.questions.delivery;
  assert(delivery?.type === "choice");
  assert.deepEqual(Object.keys(delivery.criteria).toSorted(), ["abstain", "followup", "steer"]);
  proof.stage = "runtime-consumption";
  const firstBackend = providerBodies[0];
  assert(firstBackend);
  writeOpenAiResponsesText(firstBackend.response, {
    text: "Synthetic first segment.",
    messageId: "synthetic-first",
    responseId: "synthetic-first-response",
  });
  await waitUntil(
    () => providerBodies.length === 2 && terminal(follow.params.idempotencyKey),
    "native steer consumption before second provider release",
  );
  assert.equal(terminal(follow.params.idempotencyKey)?.state, "final");
  assert.equal(
    terminal(first.params.idempotencyKey),
    undefined,
    "original turn must still be alive",
  );
  const consumedHistory = await history();
  await write("consumed-history.json", consumedHistory);
  const consumed = consumedHistory.messages
    .filter(isRecord)
    .filter(
      (message) =>
        message.idempotencyKey === follow.params.idempotencyKey + ":user" ||
        asOptionalRecord(message["__openclaw"])?.idempotencyKey ===
          follow.params.idempotencyKey + ":user",
    );
  assert.equal(consumed.length, 1);
  const receipt = consumedHistory.inputReceipts.find(
    (value) => value.runId === follow.params.idempotencyKey,
  );
  // Ordinary promotion atomically deletes its pending row; collected sources
  // retain consumed_event_id correlations. Neither absence nor advice alone
  // proves consumption: below, require the exact promoted ID and backend input.
  assert.equal(receipt, undefined);
  assert.equal(
    consumedHistory.pendingInputs.items.some((input) => input.id === queued.id),
    false,
  );
  const consumedMessage = consumed[0];
  assert(consumedMessage);
  const consumedMetadata = asOptionalRecord(consumedMessage["__openclaw"]);
  assert(consumedMetadata);
  assert.equal(consumedMetadata.id, queued.id);
  assert.equal(consumedMessage.content, correction);
  proof.canonicalPromotion = {
    acceptedInputId: queued.id,
    transcriptEntryId: consumedMetadata.id,
    pendingRetired: true,
  };
  assert.deepEqual(consumedMetadata.autoSteer, { choice: "steer", reason: "decision" });
  const targetRunId = consumedMetadata.steerTargetRunId;
  assert(typeof targetRunId === "string");
  assert(
    starts().includes(targetRunId),
    "consumption receipt must name an observed active backend run",
  );
  assert.equal(new Set(starts()).size, 1, "correction must not launch a second reply operation");
  const secondBackend = providerBodies[1];
  assert(secondBackend);
  assert(
    JSON.stringify(secondBackend.body.input).includes(correction),
    "native runtime must supply correction to next backend request",
  );
  proof.advice = consumedMetadata.autoSteer;
  proof.steerTargetRunId = targetRunId;
  proof.originalClientRunId = first.params.idempotencyKey;
  proof.correctionClientRunId = follow.params.idempotencyKey;
  proof.backendObservedCorrection = true;
  proof.beforeOriginalCompletion = true;
  writeOpenAiResponsesText(secondBackend.response, {
    text: finalText,
    messageId: "synthetic-second",
    responseId: "synthetic-second-response",
  });
  await page.getByText(finalText, { exact: true }).first().waitFor();
  await waitUntil(() => terminal(first.params.idempotencyKey), "original turn final outcome");
  assert.equal(terminal(first.params.idempotencyKey)?.state, "final");
  assert.equal(providerFault, undefined);
  assert.equal(browserFault, false);
  assert.equal(observationFault, false);
  assert.equal(providerBodies.length, 2);
  assert.equal(new Set(starts()).size, 1);
  assert.equal(sends().length, 2);
  proof.passed = true;
  proof.stage = "complete";
} catch (error) {
  proof.blocker =
    error instanceof Error && !error.message.includes("://")
      ? error.message
      : "Joined proof failed; URL-bearing error omitted to protect bootstrap authentication.";
  process.exitCode = 1;
} finally {
  // Passive capture only: no mocked WebSocket and no rewritten response/event.
  await write("frames.json", frames);
  proof.backendRequests = providerBodies.map(({ body }) => ({
    model: body.model,
    containsCorrection: JSON.stringify(body.input).includes(correction),
  }));
  if (instance) {
    const sanitized = instance
      .logs()
      .replaceAll(instance.gatewayToken, "[synthetic-token]")
      .replaceAll(instance.hookToken, "[synthetic-token]");
    await fs.writeFile(path.join(artifact, "gateway.log"), sanitized);
  }
  try {
    await browser?.close();
  } catch {
    proof.browserCleanupFailed = true;
    proof.passed = false;
    process.exitCode = 1;
  }
  try {
    await instance?.cleanup();
  } catch {
    proof.gatewayCleanupFailed = true;
    proof.passed = false;
    process.exitCode = 1;
  }
  try {
    if (provider?.listening) {
      const server = provider;
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await Promise.all([...providerHandlers, closed]);
    }
  } catch {
    proof.providerCleanupFailed = true;
    proof.passed = false;
    process.exitCode = 1;
  }
  if (providerFault || browserFault || observationFault) {
    proof.observationFailed = true;
    proof.passed = false;
    process.exitCode = 1;
  }
  if (originalTmpdir === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = originalTmpdir;
  }
  await write("proof.json", proof);
  console.log(JSON.stringify({ artifact, ...proof }, null, 2));
}
