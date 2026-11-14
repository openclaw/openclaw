import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import {
  assertManagedHandoffTestConsumer,
  createManagedHandoffTestBinding,
} from "../../test/helpers/managed-handoff-isolation.js";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as announceController from "../agents/subagents/announce/subagent-announce-controller-source.js";
import { SourceOwnerChangedError } from "../agents/subagents/announce/subagent-announce-delivery-retry.js";
import * as announceRuntime from "../agents/subagents/announce/subagent-announce.runtime.js";
import { SessionFollowupCompletion } from "../agents/subagents/completion/session-followup-completion.js";
import {
  getCurrentSubagentRunOwner,
  subagentRuns,
} from "../agents/subagents/registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import {
  loadTranscriptEvents,
  listSessionPendingInputs,
} from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { resolvePluginArtifactDeclaredSurface } from "../plugins/capability-artifact.js";
import { resolvePluginCapabilityConsent } from "../plugins/capability-consent.js";
import { computeDeclaredSurfaceHash } from "../plugins/capability-summary.js";
import { getPluginInstance, type PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import { watchPluginReplacement } from "../plugins/plugin-replacement-watchers.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import {
  inputCancellation,
  type SessionControllerInput,
} from "../sessions/session-controller.contracts.js";
import * as mailboxSource from "../sessions/session-controller.mailbox-source.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import {
  output,
  PLUGIN,
  TOOL,
  writePlugin,
  type InputItem,
} from "./server.plugin-reload-product-fixture.test-support.js";
import { createSubagentModelConfig } from "./server.subagent-stop-settlement.product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";

const ROOT = "Create a child, then deliver the original continuation exactly once.";
const CHILD = "Pause for the requester, then finish when the original continuation arrives.";
const MESSAGE = "ORIGINAL-CONTINUATION-91ce";
const DONE = "TARGET-COMPLETED-91ce";
const WAKE =
  "Continue the original task in this conversation. Do not repeat a completed operation.";

it.for(["resume", "followup", "failed-reload"] as const)(
  "settles the original %s after external reload without a model retry",
  async (scenario, { signal }) => {
    // Direct stderr survives the child JSON reporter and an interrupted process.
    const started = performance.now();
    const stage = (name: string) =>
      process.stderr.write(
        `RELOAD_PRODUCT_STAGE ${scenario} ${name} ${Math.round(performance.now() - started)}ms\n`,
      );
    stage("setup");
    const failReload = scenario === "failed-reload";
    const mode = scenario === "followup" ? "followup" : "resume";
    const pauseInputs = new Map<string, { childRunId: string; input: SessionControllerInput }>();
    const dispatches = vi.spyOn(announceRuntime, "dispatchGatewayMethodInProcess");
    const cancellations: Array<{
      input: SessionControllerInput;
      reason: unknown;
      sourceReason: unknown;
      previouslyAborted: boolean;
      phase: string;
      hasClaim: boolean;
      committed: boolean;
    }> = [];
    const abortInput = mailboxSource.abortSessionControllerInput;
    vi.spyOn(mailboxSource, "abortSessionControllerInput").mockImplementation((...args) => {
      const [input, reason] = args;
      const observation = {
        input,
        reason,
        sourceReason: dispatches.mock.calls.findLast(
          ([method, , options]) => method === "agent" && options?.controllerInput === input,
        )?.[2]?.signal?.reason as unknown,
        previouslyAborted: input.abortSignal.aborted,
        phase: input.phase,
        hasClaim: Boolean(input.claim),
      };
      // The composite signal can normalize the cause during this call. Observe
      // the exact producer request and the real owner's commit, without changing either.
      const committed = abortInput(...args);
      cancellations.push({ ...observation, committed });
      return committed;
    });
    const reserveController = announceController.reserveSubagentControllerSource;
    vi.spyOn(announceController, "reserveSubagentControllerSource").mockImplementation(
      (...args) => {
        const pending = reserveController(...args);
        // Observe the real owner without delaying or substituting its admission promise.
        void pending.then(
          (input) => {
            const [entry, , protocolRunId] = args;
            if (
              !input ||
              !protocolRunId ||
              entry.pauseReason !== "sessions_yield" ||
              !entry.requesterSettleWake?.pauseNotice
            ) {
              return;
            }
            pauseInputs.set(protocolRunId, { childRunId: entry.runId, input });
          },
          () => {},
        );
        return pending;
      },
    );
    const pauseRetirements: Array<Record<string, unknown>> = [];
    const completionOwners = vi.spyOn(SessionFollowupCompletion, "bind");
    const state = await createOpenClawTestState(
      kernelGatewayTestStateOptions("plugin-reload-send-continuation"),
    );
    const inheritedHandoff = process.env.OPENCLAW_TEST_PRIVATE_HANDOFF_PATH;
    assert(inheritedHandoff, "Product entry must bind the handoff store before imports");
    const handoffBinding = createManagedHandoffTestBinding(path.dirname(inheritedHandoff));
    const pluginRoot = state.path("external-plugin");
    const hooksFile = state.path("hooks.log");
    const sessionKey = "agent:main:dashboard:" + randomUUID();
    const parentRunId = randomUUID();
    const paused = createDeferred<SubagentRunRecord>();
    const completed = createDeferred<SubagentRunRecord>();
    const sendResult = createDeferred<Record<string, unknown>>();
    const handoffWake = createDeferred<string>();
    const childAnnouncement = createDeferred();
    const failure = createDeferred<never>();
    void failure.promise.catch(() => {});
    let child: { runId: string; sessionKey: string } | undefined;
    let held: PluginInstanceHandle | undefined;
    let reload: Promise<unknown> | undefined;
    let unwatch = () => {};
    let spawned = false;
    let childYielded = false;
    let probed = false;
    let sent = false;
    let sendStarts = 0;
    const seenRootUserItems = new Set<string>();
    let effects = 0;
    const wakes: string[] = [];
    const rootRuns = new Set<string>();
    const referenceCountsAtEffect: number[] = [];
    const watchTask = () => {
      if (!child) {
        return;
      }
      for (const entry of subagentRuns.values()) {
        if (entry.childSessionKey !== child.sessionKey) {
          continue;
        }
        if (entry.pauseReason === "sessions_yield") {
          paused.resolve(entry);
        }
        if (entry.endedReason === "subagent-complete") {
          completed.resolve(entry);
        }
      }
    };
    const stopTaskWatch = subscribeSubagentRunChanges("projection", watchTask);
    const stopEvents = onAgentEvent((event) => {
      if (event.sessionKey === sessionKey) {
        rootRuns.add(event.runId);
        if (
          event.stream === "tool" &&
          event.data.name === "sessions_send" &&
          event.data.phase === "start"
        ) {
          sendStarts++;
        }
      }
      if (
        event.runId !== parentRunId ||
        event.stream !== "tool" ||
        event.data.name !== "sessions_send" ||
        event.data.phase !== "result"
      ) {
        return;
      }
      const result = event.data.result as { details?: Record<string, unknown> } | undefined;
      if (result?.details) {
        sendResult.resolve(result.details);
      }
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let model: Awaited<ReturnType<typeof startOpenAiResponsesModelServer>> | undefined;
    try {
      await writePlugin(pluginRoot, hooksFile, state.path("generation"), failReload);
      model = await startOpenAiResponsesModelServer({
        modelId: "reload-send-proof",
        bindError: "Expected private continuation model server",
        onRequest: async (request, response) => {
          try {
            const raw = await readRequestText(request);
            const body = JSON.parse(raw) as { input?: InputItem[] };
            const reply = (text: string) =>
              writeOpenAiResponsesText(response, {
                text,
                messageId: randomUUID(),
                responseId: randomUUID(),
              });
            if (raw.includes(ROOT)) {
              if (!spawned) {
                stage("spawn");
                spawned = true;
                writeToolCall(response, "sessions_spawn", {
                  task: CHILD,
                  context: "isolated",
                  expectsCompletionMessage: true,
                  cleanup: "keep",
                });
                return;
              }
              if (!child) {
                const receipt = output(body, "sessions_spawn");
                assert.equal(receipt?.status, "accepted");
                assert.equal(typeof receipt?.runId, "string");
                assert.equal(typeof receipt?.childSessionKey, "string");
                child = {
                  runId: receipt.runId as string,
                  sessionKey: receipt.childSessionKey as string,
                };
                watchTask();
              }
              if (!probed) {
                await withinTest(mode === "resume" ? paused.promise : completed.promise, signal);
                probed = true;
                writeToolCall(response, TOOL, {});
                return;
              }
              if (!sent) {
                expect(output(body, TOOL)).toMatchObject({ plugin: PLUGIN, generation: 1 });
                const record = getActivePluginRegistry()?.plugins.find(
                  (item) => item.id === PLUGIN,
                );
                assert(record, "The actual Gateway must publish the external plugin");
                held = getPluginInstance(record);
                assert(held, "The caller must hold the actual loaded instance");
                expect(held.retentionSnapshot().total).toBeGreaterThan(0);
                const replacement = createDeferred();
                unwatch = watchPluginReplacement(held, () => replacement.resolve());
                assert(gateway);
                stage("reload-request");
                reload = gateway.client
                  .request("plugins.reload", {
                    plugins: [{ pluginId: PLUGIN }],
                  })
                  .catch((error: unknown) => {
                    if (!failReload) {
                      throw error;
                    }
                    return { ok: false, error };
                  });
                await withinTest(
                  awaitGateBeforeSettlement(
                    replacement.promise,
                    reload,
                    "Reload settled without reserving the held instance",
                  ),
                  signal,
                );
                expect(held.replacementPending).toBe(true);
                stage("replacement-reserved-send");
                sent = true;
                writeToolCall(response, "sessions_send", {
                  sessionKey: child.sessionKey,
                  message: MESSAGE,
                  mode,
                  timeoutSeconds: 0,
                });
                return;
              }
              // Completion and handoff inputs can replace each other at the same
              // position. Deduplicate observations, not positional history.
              const items = body.input ?? [];
              const call = items.findLast(
                (item) => item.type === "function_call" && item.name === "sessions_send",
              );
              const outputIndex = items.findIndex(
                (item) => item.type === "function_call_output" && item.call_id === call?.call_id,
              );
              const users =
                outputIndex < 0
                  ? []
                  : items.slice(outputIndex + 1).filter((item) => item.role === "user");
              for (const item of users) {
                const text = JSON.stringify(item);
                if (seenRootUserItems.has(text)) {
                  continue;
                }
                seenRootUserItems.add(text);
                for (let count = text.split(WAKE).length - 1; count > 0; count--) {
                  wakes.push(text);
                  handoffWake.resolve(text);
                }
                if (text.includes(DONE)) {
                  childAnnouncement.resolve();
                }
              }
              // Never retry, including on a refusal or either host-originated input.
              reply("Caller finished without retrying the send.");
              return;
            }
            if (raw.includes(CHILD)) {
              if (raw.includes(MESSAGE)) {
                stage("continuation-effect");
                effects++;
                referenceCountsAtEffect.push(held?.retentionSnapshot().total ?? -1);
                reply(DONE);
              } else if (mode === "followup") {
                reply("Child ready for a new followup.");
              } else if (!childYielded) {
                childYielded = true;
                writeToolCall(response, "sessions_yield", {
                  waitFor: "message",
                  acknowledgment: "Waiting for the original continuation.",
                });
              } else {
                reply("NO_REPLY");
              }
              return;
            }
            reply("NO_REPLY");
          } catch (error) {
            failure.reject(error);
            response.destroy(error instanceof Error ? error : undefined);
          }
        },
      });
      const base = createSubagentModelConfig(state.workspaceDir, {
        baseUrl: model.baseUrl + "/v1",
        modelId: "reload-send-proof",
        name: "Reload send proof",
        runtime: true,
      });
      const cfg = {
        ...base,
        skills: { load: { watch: false } },
        plugins: {
          enabled: true,
          allow: [PLUGIN],
          load: { paths: [pluginRoot] },
          slots: { memory: "none" },
          entries: { [PLUGIN]: { enabled: true, hooks: { allowConversationAccess: true } } },
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
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token: "reload-send-proof-token",
        scopes: ["operator.admin"],
      });
      await withinTest(gateway.server.startupSettled, signal);
      stage("startup-settled");
      await gateway.client.request("chat.send", {
        sessionKey,
        message: ROOT,
        idempotencyKey: parentRunId,
        deliver: false,
      });
      const result = await withinTest(Promise.race([sendResult.promise, failure.promise]), signal);
      stage("send-result");
      const callerSettlement = await withinTest(
        gateway.client.request("agent.wait", { runId: parentRunId, timeoutMs: 30_000 }),
        signal,
      );
      expect(callerSettlement).toMatchObject({ status: "ok" });
      stage("caller-settled");
      assert(reload);
      const reloadResult = await withinTest(reload, signal);
      stage("reload-settled");
      expect(reloadResult).toMatchObject(
        failReload ? { ok: false } : { ok: true, restartRequired: false, pluginIds: [PLUGIN] },
      );
      assert(child && held);
      const original = await withinTest(
        mode === "resume" ? paused.promise : completed.promise,
        signal,
      );
      // A flat refusal has no future owner to await. Observe its actual settled target,
      // so RED is the lost effect, not merely the missing additive output fields.
      if (result.status === "started") {
        await withinTest(
          Promise.race([
            handoffWake.promise.then((text) => {
              const item: unknown = JSON.parse(text);
              assert(isRecord(item));
              const content =
                typeof item.content === "string"
                  ? item.content
                  : Array.isArray(item.content)
                    ? item.content
                        .flatMap((part) =>
                          isRecord(part) && typeof part.text === "string" ? [part.text] : [],
                        )
                        .join("\n")
                    : "";
              const marker = "Session send result: ";
              const payload: unknown = JSON.parse(
                content.slice(
                  content.indexOf(marker) + marker.length,
                  content.indexOf("\n" + WAKE),
                ),
              );
              assert(isRecord(payload) && Array.isArray(payload.outcomes));
              expect(payload.outcomes.length).toBe(1);
              const outcome: unknown = payload.outcomes[0];
              assert(isRecord(outcome));
              expect(outcome.runId).toBe(result.runId);
              if (failReload) {
                expect(outcome).toMatchObject({ status: "not_delivered", reason: "reload_failed" });
                return undefined;
              }
              expect(
                ["error", "forbidden", "uncertain", "not_delivered"].includes(
                  String(outcome.status),
                ),
                "Retained send replay must not fail before target execution",
              ).toBe(false);
              return Promise.all([completed.promise, childAnnouncement.promise]);
            }),
            failure.promise,
          ]),
          signal,
        );
      }
      // On the retained path, both expected inputs have reached the model before this snapshot.
      stage("wake-and-announcement");
      const rootSettlements = await withinTest(
        Promise.all(
          [...rootRuns].map((runId) =>
            gateway!.client.request("agent.wait", { runId, timeoutMs: 30_000 }),
          ),
        ),
        signal,
      );
      for (const settlement of rootSettlements) {
        assert(isRecord(settlement));
        if (settlement.status === "error") {
          // Adoption retires the old child's pause-notice input. Its
          // RPC cancellation is not a failure of the retained send or its wake.
          // Require that exact owner/cause; never accept an arbitrary failed run.
          const pause = pauseInputs.get(String(settlement.runId));
          assert(pause, JSON.stringify(settlement));
          expect(pause.childRunId).toBe(child.runId);
          const committed = cancellations.filter(
            (cancellation) => cancellation.input === pause.input && cancellation.committed,
          );
          expect(committed).toHaveLength(1);
          const retirement = committed[0]!;
          expect(retirement.previouslyAborted).toBe(false);
          expect(scenario).toBe("resume");
          expect(getCurrentSubagentRunOwner(subagentRuns, original)).toBeUndefined();
          expect(subagentRuns.get(String(result.runId))).toMatchObject({
            childSessionKey: child.sessionKey,
            taskRunId: original.taskRunId ?? original.runId,
            endedReason: "subagent-complete",
          });
          const sourceDispatch = dispatches.mock.calls.filter(
            ([method, , options]) => method === "agent" && options?.controllerInput === pause.input,
          );
          expect(sourceDispatch).toHaveLength(1);
          const sourceReason = retirement.sourceReason;
          if (sourceReason instanceof SourceOwnerChangedError) {
            // A claimed obsolete notice is cancelled by the delivery owner's guard.
            // Gateway normalizes that exact source's cancellation before the input sees it.
            expect(sourceDispatch[0]![2]?.signal?.aborted).toBe(true);
          } else {
            // Before claim, registry retirement cancels the same input directly.
            expect(retirement.reason).toEqual(new Error("Subagent obligation retired"));
          }
          expect(pause.input[inputCancellation].signal.reason).toBe(retirement.reason);
          await withinTest(pause.input.settlement.promise, signal);
          expect(pause.input.phase).toBe("consumed");
          expect(settlement).toMatchObject({ status: "error", stopReason: "rpc" });
          pauseRetirements.push({
            childRunId: pause.childRunId,
            protocolRunId: settlement.runId,
            phaseAtCancellation: retirement.phase,
            hadClaim: retirement.hasClaim,
            previouslyAborted: retirement.previouslyAborted,
            committed: retirement.committed,
            sourceCause: sourceReason instanceof Error ? sourceReason.name : undefined,
            inputCause: retirement.reason instanceof Error ? retirement.reason.message : undefined,
            obsoleteOwner: true,
            settlementJoined: true,
          });
        } else {
          expect(settlement, JSON.stringify(settlement)).toMatchObject({ status: "ok" });
        }
      }
      const childSessionKey = child.sessionKey;
      const target = [...subagentRuns.values()].find(
        (entry) => entry.childSessionKey === childSessionKey,
      );
      const entry = await readSessionEntryReadOnlyInWorker({
        agentId: "main",
        sessionKey: child.sessionKey,
      });
      assert(entry?.sessionId, "The real spawned child must have its own session");
      const scope = { agentId: "main", sessionKey: child.sessionKey, sessionId: entry.sessionId };
      assert(typeof result.runId === "string", JSON.stringify(result));
      // A single input's pending row is deleted when promoted. Its durable receipt
      // is the transcript message, not the collected-input receipt projection.
      const receipts = (await loadTranscriptEvents(scope)).flatMap((event) =>
        isRecord(event) &&
        event.type === "message" &&
        isRecord(event.message) &&
        event.message.role === "user" &&
        JSON.stringify(event.message.content).includes(MESSAGE)
          ? [event.message]
          : [],
      );
      const pending = await listSessionPendingInputs(scope);
      const hooks = (await fs.readFile(hooksFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; runId?: string });
      expect(sendStarts).toBe(1);
      expect(held.retentionSnapshot().total).toBe(0);
      expect
        .soft(effects, "Only a healthy reload permits the original continuation")
        .toBe(failReload ? 0 : 1);
      if (failReload) {
        expect(target).toMatchObject({ runId: original.runId, pauseReason: "sessions_yield" });
      } else if (mode === "resume") {
        expect.soft(target).toMatchObject({
          taskRunId: original.taskRunId ?? original.runId,
          endedReason: "subagent-complete",
        });
        expect.soft(target?.pauseReason).toBeUndefined();
      } else {
        const owners = completionOwners.mock.results.flatMap((binding) =>
          binding.type === "return" && binding.value.accepted ? [binding.value] : [],
        );
        expect(owners).toHaveLength(1);
        expect(owners[0]?.request).toMatchObject({
          runId: result.runId,
          requesterSessionKey: sessionKey,
          targetSessionKey: child.sessionKey,
        });
        expect(
          await withinTest(
            gateway.client.request("agent.wait", { runId: result.runId, timeoutMs: 30_000 }),
            signal,
          ),
        ).toMatchObject({ status: "ok" });
      }
      expect.soft(receipts).toHaveLength(failReload ? 0 : 1);
      if (!failReload) {
        expect.soft(receipts[0]?.idempotencyKey).toBe(result.runId + ":user");
      }
      expect(pending).toEqual({ items: [], total: 0 });
      expect.soft(result).toMatchObject({
        status: "started",
        runId: expect.any(String),
        retained: {
          acceptance: "not_accepted",
          reason: "plugin_reload_self_hold",
          plugins: [PLUGIN],
        },
      });
      const rootEntry = await readSessionEntryReadOnlyInWorker({
        agentId: "main",
        sessionKey,
      });
      assert(rootEntry?.sessionId);
      const rootTranscript = await loadTranscriptEvents({
        agentId: "main",
        sessionKey,
        sessionId: rootEntry.sessionId,
      });
      const durableWakes = rootTranscript.filter(
        (event) =>
          isRecord(event) &&
          event.type === "message" &&
          isRecord(event.message) &&
          event.message.role === "user" &&
          JSON.stringify(event.message.content).includes(WAKE),
      );
      expect(durableWakes).toHaveLength(1);
      expect.soft(wakes).toHaveLength(1);
      expect.soft(wakes[0] ?? "").toContain(result.runId as string);
      expect.soft(referenceCountsAtEffect).toEqual(failReload ? [] : [0]);
      expect(
        hooks.filter((hook) => hook.event === "agent_end" && hook.runId === parentRunId),
      ).toHaveLength(1);
      expect(
        hooks.filter((hook) => hook.event === "llm_output" && hook.runId === parentRunId),
      ).toHaveLength(1);
    } finally {
      unwatch();
      stopEvents();
      stopTaskWatch();
      // Close HTTP first to release any fixture request waiting on an aborted test.
      stage("close-model");
      await model?.close();
      stage("close-gateway");
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "reload send continuation proof complete" });
      }
      if (reload) {
        await Promise.allSettled([reload]);
      }
      await resetSubagentRegistryForTests({ persist: false });
      vi.restoreAllMocks();
      await state.cleanup();
      stage("cleanup-complete");
      assertManagedHandoffTestConsumer(
        handoffBinding,
        process.pid,
        path.join(process.cwd(), "src/infra"),
      );
      await fs.writeFile(
        path.join(handoffBinding.directory, `reload-case-${scenario}.json`),
        JSON.stringify({
          scenario,
          pid: process.pid,
          runtime: process.versions.bun ? "bun" : "node",
          sendStarts,
          effects,
          wakes: wakes.length,
          databasePath: handoffBinding.databasePath,
          pauseRetirements,
        }),
      );
    }
  },
);
