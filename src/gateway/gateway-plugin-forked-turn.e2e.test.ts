import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  assertStableProviderPrefix,
  snapshotProviderPrefix,
} from "../../scripts/e2e/lib/anthropic-cache/prefix-stability.mts";
import { createDeferred } from "../../test/helpers/promise.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryWithKey,
} from "../config/sessions/session-accessor.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { revokePluginRecord } from "../plugins/registry-lifecycle.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getActiveGatewayRootWorkHolders } from "../process/gateway-work-admission.js";
import { type Turn, withForkGateway } from "./gateway-plugin-forked-turn.test-support.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

describe("plugin forked turns through the real Gateway", () => {
  it(
    "runs a hidden fork that executes only the plugin's own tool, settles inside admission, and refuses replaced sessions",
    { timeout: 150_000 },
    async () => {
      await withForkGateway(
        (config) => config,
        async (fixture) => {
          const { proof, forkRequests } = fixture;
          const turn = await fixture.dashboardTurn(
            `agent:main:dashboard:direct:fork-proof-${randomUUID()}`,
          );
          const { sessionKey, sessionId, entryId, scope } = turn;
          const transcript = () => loadTranscriptEventsSync({ ...scope, sessionId });

          // Trust rule: the plugin's own tools, plus read, ls and exec under the session's policy.
          await expect(fixture.fork(turn, { tools: ["process"] })).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining('may not add core tool "process"'),
          });
          await expect(fixture.fork(turn, { tools: ["fork_other_note"] })).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining(
              'does not uniquely own subagent tool "fork_other_note"',
            ),
          });
          await expect(
            fixture.fork(turn, { through: { sessionId: "stale", entryId } }),
          ).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining("was reset or replaced"),
          });
          await expect(
            fixture.fork(turn, { through: { sessionId, entryId: "missing" } }),
          ).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining('has no active entry "missing"'),
          });
          expect(forkRequests).toEqual([]);

          // The plugin's agent_end hook names the entry that ended the turn, ready to fork.
          await expect
            .poll(() => proof.agentEnds.find((end) => end.sessionKey === sessionKey))
            .toEqual({ sessionKey, completedTurn: { sessionId, entryId } });
          const completedTurn = proof.agentEnds.find((end) => end.sessionKey === sessionKey)
            ?.completedTurn as { sessionId: string; entryId: string };

          const before = JSON.stringify(transcript());
          const runId = `fork-proof-${randomUUID()}`;
          const release = createDeferred();
          const started = createDeferred();
          proof.hold = { started, release: release.promise };
          const pending = fixture.fork(turn, { runId, through: completedTurn });
          await started.promise;
          // Settlement holds the fork's detached admission; a graceful restart waits for it.
          expect(getActiveGatewayRootWorkHolders()).toContain("plugin:fork-proof:session-fork");
          release.resolve();
          await expect(pending).resolves.toEqual({
            ok: true,
            result: { status: "settled", runId, value: "settled-value" },
          });
          expect(getActiveGatewayRootWorkHolders()).not.toContain("plugin:fork-proof:session-fork");
          expect(proof.settled).toEqual([
            {
              ok: true,
              runId,
              text: "FORK_DONE",
              source: { sessionId, lifecycleRevision: expect.anything() },
              error: undefined,
            },
          ]);
          expect(proof.toolCalls).toEqual([
            {
              args: { note: "fork saw the turn" },
              backgroundRun: { sourceSessionKey: sessionKey, ownerPluginId: "fork-proof" },
              runId,
              // The admin caller's owner authority reaches the fork's tools.
              senderIsOwner: true,
            },
          ]);
          // The fork lists the session's own tools; only the caller's tool ran (above).
          expect(forkRequests[0]?.tools).toEqual(fixture.foregroundRequests.at(-1)?.tools);
          // The fork runs on the model the anchored turn ran on.
          expect(forkRequests[0]?.model).toBe(fixture.foregroundRequests[0]?.model);
          // A hidden fork never writes the source transcript.
          expect(JSON.stringify(transcript())).toBe(before);

          // A Gateway reset keeps the session id and rotates its lifecycle revision. The fork
          // still reads through the completed entry, and reports the generation it read so
          // follow-up writes can skip the newer generation.
          const firstGeneration = proof.settled[0]?.source as { lifecycleRevision?: unknown };
          await fixture.client.request("sessions.reset", { key: sessionKey });
          const resetEntry = loadSessionEntry(scope);
          expect(resetEntry?.sessionId).toBe(sessionId);
          await expect(fixture.fork(turn, {})).resolves.toMatchObject({
            ok: true,
            result: { status: "settled" },
          });
          expect(proof.settled[1]?.source).toEqual({
            sessionId,
            lifecycleRevision: resetEntry?.lifecycleRevision,
          });
          expect(resetEntry?.lifecycleRevision).not.toBe(firstGeneration.lifecycleRevision);

          // The session's own deny policy still applies to the plugin's tool.
          const forkCalls = forkRequests.length;
          await fixture.patchConfig({ tools: { deny: ["fork_proof_note"] } });
          await expect
            .poll(async () => fixture.fork(turn, {}), { timeout: 30_000, interval: 500 })
            .toEqual({ ok: true, result: { status: "refused", reason: "tool_policy" } });
          expect(forkRequests).toHaveLength(forkCalls);
        },
      );
    },
  );

  it(
    "checks policy as the anchored turn's sender and keeps the turn's model",
    { timeout: 150_000 },
    async () => {
      await withForkGateway(
        (config) => ({
          ...config,
          // Sender 42 may not use the plugin's tool; the stored session never records senders.
          tools: { ...config.tools, toolsBySender: { "id:42": { deny: ["fork_proof_note"] } } },
        }),
        async (fixture) => {
          const blocked = await fixture.channelTurn(
            `agent:main:telegram:direct:fork-proof-42-${randomUUID()}`,
            "42",
          );
          const allowed = await fixture.channelTurn(
            `agent:main:telegram:direct:fork-proof-7-${randomUUID()}`,
            "7",
          );
          await expect(fixture.fork(blocked, {})).resolves.toEqual({
            ok: true,
            result: { status: "refused", reason: "tool_policy" },
          });
          expect(fixture.forkRequests).toEqual([]);
          await expect(fixture.fork(allowed, {})).resolves.toMatchObject({
            ok: true,
            result: { status: "settled" },
          });
          // Owner authority is the caller's, never the turn's: the admin's fork of a channel
          // sender's turn runs as owner, while sender policy still follows the turn.
          expect(fixture.proof.toolCalls).toEqual([
            expect.objectContaining({ senderIsOwner: true }),
          ]);
          // The fork runs on the model the anchored turn ran on.
          expect(fixture.forkRequests[0]?.model).toBe(fixture.foregroundRequests.at(-1)?.model);

          // A long tool loop pushes the initiating input far behind the anchor; the requester
          // still comes from that input, so the sender's deny still applies.
          fixture.foreground.toolCalls = 40;
          const longBlocked = await fixture.channelTurn(
            `agent:main:telegram:direct:fork-proof-long-42-${randomUUID()}`,
            "42",
          );
          expect(fixture.foreground.toolCalls).toBe(0);
          expect(
            loadTranscriptEventsSync({
              ...longBlocked.scope,
              sessionId: longBlocked.sessionId,
            }).length,
          ).toBeGreaterThan(64);
          const longForkCalls = fixture.forkRequests.length;
          await expect(fixture.fork(longBlocked, {})).resolves.toEqual({
            ok: true,
            result: { status: "refused", reason: "tool_policy" },
          });
          expect(fixture.forkRequests).toHaveLength(longForkCalls);

          // Agent-command ingress turns record the same requester, so forks check it too.
          const ingressBlocked = await fixture.ingressTurn(
            `agent:main:telegram:direct:fork-proof-ingress-42-${randomUUID()}`,
            "42",
          );
          const ingressAllowed = await fixture.ingressTurn(
            `agent:main:telegram:direct:fork-proof-ingress-7-${randomUUID()}`,
            "7",
          );
          const forkCalls = fixture.forkRequests.length;
          await expect(fixture.fork(ingressBlocked, {})).resolves.toEqual({
            ok: true,
            result: { status: "refused", reason: "tool_policy" },
          });
          expect(fixture.forkRequests).toHaveLength(forkCalls);
          await expect(fixture.fork(ingressAllowed, {})).resolves.toMatchObject({
            ok: true,
            result: { status: "settled" },
          });

          // Overrides need trust unless they name the turn's own model.
          const writer = await connectGatewayClient({
            url: `ws://127.0.0.1:${fixture.port}`,
            token: fixture.token,
            scopes: ["operator.write"],
          });
          try {
            await expect(
              fixture.fork(allowed, { provider: "mock-openai", model: "other-model" }, writer),
            ).resolves.toMatchObject({
              ok: false,
              message: expect.stringContaining("override is not authorized"),
            });
            await expect(
              fixture.fork(allowed, { provider: "mock-openai", model: "fork-proof" }, writer),
            ).resolves.toMatchObject({ ok: true, result: { status: "settled" } });
            // A caller without owner authority forks as an explicit non-owner.
            expect(fixture.proof.toolCalls.at(-1)).toMatchObject({ senderIsOwner: false });
          } finally {
            await disconnectGatewayClient(writer);
          }
        },
      );
    },
  );

  it(
    "runs the fork on the auth profile the session's turns use",
    { timeout: 150_000 },
    async () => {
      const first = "mock-openai:first";
      const rotated = "mock-openai:rotated";
      await withForkGateway(
        (config) => {
          // Profiles are the only credential source: the provider config carries no key.
          const { apiKey: _apiKey, ...mock } = expectDefined(
            config.models?.providers?.["mock-openai"],
            "mock provider",
          );
          return {
            ...config,
            auth: {
              profiles: {
                [first]: { provider: "mock-openai", mode: "api_key" },
                [rotated]: { provider: "mock-openai", mode: "api_key" },
              },
              order: { "mock-openai": [first, rotated] },
            },
            models: { ...config.models, providers: { "mock-openai": mock } },
          };
        },
        async (fixture) => {
          await persistAuthProfileBatch({
            profiles: [first, rotated].map((profileId) => ({
              profileId,
              credential: { type: "api_key", provider: "mock-openai", key: `key-${profileId}` },
            })),
          });
          // With no stored selection, as in the fork's internal session, the order picks the first.
          await fixture.dashboardTurn(
            `agent:main:dashboard:direct:fork-proof-auth-${randomUUID()}`,
          );
          expect(fixture.authorizations.foreground.splice(0)).toEqual([`Bearer key-${first}`]);
          const sessionKey = `agent:main:dashboard:direct:fork-proof-auth-${randomUUID()}`;
          await fixture.client.request("sessions.create", { key: sessionKey });
          // Automatic rotation moved the session off the first profile in the order.
          await patchSessionEntryWithKey(
            {
              agentId: "main",
              sessionKey,
              storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
            },
            () => ({ authProfileOverride: rotated, authProfileOverrideSource: "auto" }),
          );
          const turn = await fixture.dashboardTurn(sessionKey);
          expect(fixture.authorizations.foreground).toEqual([`Bearer key-${rotated}`]);
          await expect(fixture.fork(turn, {})).resolves.toMatchObject({
            ok: true,
            result: { status: "settled" },
          });
          // Both fork requests (tool call, then answer) use the session's profile.
          expect(fixture.authorizations.fork).toEqual([
            `Bearer key-${rotated}`,
            `Bearer key-${rotated}`,
          ]);
        },
      );
    },
  );

  it(
    "drains an in-flight fork through settlement on reload and refuses the retired runtime",
    { timeout: 150_000 },
    async () => {
      await withForkGateway(
        (config) => config,
        async (fixture) => {
          const turn = await fixture.dashboardTurn(
            `agent:main:dashboard:direct:fork-proof-reload-${randomUUID()}`,
          );
          const through = { sessionId: turn.sessionId, entryId: turn.entryId };
          const started = createDeferred();
          const release = createDeferred();
          fixture.modelHold.current = { started, release: release.promise };
          await fixture.client.request("forkproof.start", { sessionKey: turn.sessionKey, through });
          await started.promise;
          // A turn in another session does not stop the held fork; it settles ok below.
          await fixture.dashboardTurn(
            `agent:main:dashboard:direct:fork-proof-other-${randomUUID()}`,
          );
          const pending = fixture.proof.background;
          const forkProofRecord = () =>
            getActivePluginRegistry()?.plugins.find((plugin) => plugin.id === "fork-proof");
          const original = forkProofRecord();
          const retired = fixture.proof.runtimes[0];
          // The real reload path waits for this registration's in-flight fork.
          let reloaded = false;
          const reload = fixture.client
            .request(
              "plugins.reload",
              { plugins: [{ pluginId: "fork-proof" }] },
              { timeoutMs: 60_000 },
            )
            .then(() => {
              reloaded = true;
            });
          // The reload has reserved this instance and is waiting for the fork's held work.
          const instance = original ? getPluginInstance(original) : undefined;
          await expect
            .poll(() => instance?.replacementPending, { timeout: 30_000, interval: 50 })
            .toBe(true);
          expect(reloaded).toBe(false);
          expect(forkProofRecord()).toBe(original);
          release.resolve();
          // The draining registration stays the live owner: its tool and settlement both run.
          await expect(pending).resolves.toMatchObject({
            ok: true,
            result: { status: "settled", value: "settled-value" },
          });
          expect(fixture.proof.toolCalls).toHaveLength(1);
          expect(fixture.proof.settled).toEqual([expect.objectContaining({ ok: true })]);
          await reload;
          expect(forkProofRecord()).not.toBe(original);

          // A retained runtime of the retired registration is refused before any fork work.
          await expect(
            retired?.runForkedTurn({
              sessionKey: turn.sessionKey,
              through,
              prompt: "Record one note about this conversation.",
              tools: ["fork_proof_note"],
              onSettled: () => "never",
            }),
          ).rejects.toThrow('Plugin "fork-proof" runtime is no longer active');
          expect(fixture.proof.toolCalls).toHaveLength(1);
          expect(fixture.proof.settled).toHaveLength(1);
        },
      );
    },
  );

  it(
    "keeps the parent's prompt prefix stable and sends deterministic fork prefixes",
    { timeout: 150_000 },
    async () => {
      await withForkGateway(
        (config) => config,
        async (fixture) => {
          const sessionKey = `agent:main:dashboard:direct:fork-proof-cache-${randomUUID()}`;
          const turn = await fixture.dashboardTurn(sessionKey);
          const parentRequest = expectDefined(fixture.foregroundRequests.at(-1), "parent request");
          const parentN = snapshotProviderPrefix("openai-responses", parentRequest);
          const transcript = () =>
            JSON.stringify(loadTranscriptEventsSync({ ...turn.scope, sessionId: turn.sessionId }));
          const before = transcript();

          // Two forks of the same anchor.
          for (let index = 0; index < 2; index += 1) {
            await expect(fixture.fork(turn, {})).resolves.toMatchObject({
              ok: true,
              result: { status: "settled" },
            });
          }
          // (b) A fork never writes the parent transcript.
          expect(transcript()).toBe(before);
          const forkFirst = fixture.forkRequests.filter(
            (request) => !request.input?.some((item) => item.type === "function_call_output"),
          );
          expect(forkFirst).toHaveLength(2);
          const [forkA, forkB] = forkFirst.map((request) =>
            snapshotProviderPrefix("openai-responses", request),
          );
          if (!forkA || !forkB) {
            throw new Error("Both forks must reach the provider");
          }
          // Turn N's request ends with the per-turn runtime context, which is never persisted.
          // Its stable prefix is the system message and turn N's user message; the anchor is
          // turn N's assistant reply, one item later.
          const runtimeContext = parentN.history.findIndex((item) =>
            item.includes("OpenClaw runtime context"),
          );
          const stableLength = runtimeContext === -1 ? parentN.history.length : runtimeContext;
          const anchoredLength = stableLength + 1;
          // (c) The same anchor sends byte-identical prefixes: system, tools, cache key, and the
          // history through the anchor. Only the fork prompt after it carries the current time.
          assertStableProviderPrefix(forkA, forkB, {
            label: "fork determinism",
            historyLength: anchoredLength,
          });

          // (a) The parent's next turn keeps its whole prior prefix.
          await fixture.dashboardTurn(sessionKey);
          const parentNext = snapshotProviderPrefix(
            "openai-responses",
            fixture.foregroundRequests.at(-1),
          );
          assertStableProviderPrefix(parentN, parentNext, {
            label: "parent after fork",
            historyLength: stableLength,
          });

          // (d) The fork sends the parent's request: the same system prompt, tools, cache key
          // and history through the parent's persisted prefix, and the same output limit and
          // reasoning, with no background prompt, tool list or token clamps of its own.
          assertStableProviderPrefix(parentN, forkA, {
            label: "fork extends parent",
            historyLength: stableLength,
          });
          const { input: _parentInput, ...parentFields } = parentRequest;
          const { input: _forkInput, ...forkFields } = expectDefined(forkFirst[0], "fork request");
          expect(forkFields).toEqual(parentFields);
        },
      );
    },
  );

  it(
    "stops a revoked plugin's fork before its next tool effect and skips settlement",
    { timeout: 150_000 },
    async () => {
      await withForkGateway(
        (config) => config,
        async (fixture) => {
          const turn = await fixture.dashboardTurn(
            `agent:main:dashboard:direct:fork-proof-revoke-${randomUUID()}`,
          );
          const started = createDeferred();
          const release = createDeferred();
          fixture.modelHold.current = { started, release: release.promise };
          await fixture.client.request("forkproof.start", {
            sessionKey: turn.sessionKey,
            through: { sessionId: turn.sessionId, entryId: turn.entryId },
          });
          await started.promise;
          const pending = fixture.proof.background;
          // The fork is waiting on the model, which will ask for the plugin's tool. Revoke the
          // plugin record through the lifecycle owner before that tool call arrives.
          const registry = getActivePluginRegistry();
          const record = registry?.plugins.find((plugin) => plugin.id === "fork-proof");
          if (!registry || !record) {
            throw new Error("fork-proof plugin is not loaded");
          }
          revokePluginRecord(registry, record);
          release.resolve();
          await expect(pending).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining('Plugin "fork-proof" runtime is no longer active'),
          });
          // No tool effect ran after revocation, and the revoked plugin's settlement never ran.
          expect(fixture.proof.toolCalls).toEqual([]);
          expect(fixture.proof.settled).toEqual([]);
          // The model's tool call was the last step: no tool result went back to the model.
          expect(fixture.forkRequests).toHaveLength(1);
        },
      );
    },
  );

  it(
    "falls back for legacy turns, skips steering, and refuses a turn whose input is gone",
    { timeout: 150_000 },
    async () => {
      await withForkGateway(
        (config) => ({
          ...config,
          tools: { ...config.tools, toolsBySender: { "id:42": { deny: ["fork_proof_note"] } } },
        }),
        async (fixture) => {
          const assistant = (text: string) => ({
            role: "assistant",
            content: [{ type: "text", text }],
            api: "openai-responses",
            provider: "mock-openai",
            model: "fork-proof",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 2,
          });
          // Writes stored turns directly through the transcript owner, as older releases left them.
          const storedTurn = async (messages: Array<Record<string, unknown>>): Promise<Turn> => {
            const sessionKey = `agent:main:dashboard:direct:fork-proof-stored-${randomUUID()}`;
            await fixture.client.request("sessions.create", { key: sessionKey });
            const scope = {
              agentId: "main",
              sessionKey,
              storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
            };
            const sessionId = expectDefined(loadSessionEntry(scope)?.sessionId, "session id");
            const session = await SessionManager.openAsync(
              { ...scope, sessionId },
              fixture.workspaceDir,
            );
            let entryId: string | undefined;
            for (const message of messages) {
              // SAFETY: fixtures follow the stored message shapes the transcript owner accepts.
              entryId = (await session.appendMessageAsync(message as never)) ?? entryId;
            }
            return { sessionKey, sessionId, entryId: expectDefined(entryId, "entry"), scope };
          };

          // A turn stored before requester recording uses the session's stored facts.
          const legacy = await storedTurn([
            { role: "user", content: "Hello", timestamp: 1 },
            assistant("Hi"),
          ]);
          await expect(fixture.fork(legacy, {})).resolves.toMatchObject({
            ok: true,
            result: { status: "settled" },
          });

          // A delivery mirror is an assistant row no provider answered. A fork through it runs
          // on the model of the turn's last provider response, never on the mirror's marker.
          const mirrored = await storedTurn([
            { role: "user", content: "Hello", timestamp: 1 },
            assistant("Hi"),
            {
              ...assistant("Hi"),
              api: "openclaw-transcript",
              provider: "openclaw",
              model: "delivery-mirror",
              timestamp: 3,
            },
          ]);
          await expect(fixture.fork(mirrored, {})).resolves.toMatchObject({
            ok: true,
            result: { status: "settled" },
          });
          // Settlement carries the run's own outcome; a fork sent to the marker fails there.
          expect(fixture.proof.settled.at(-1)).toMatchObject({ ok: true, error: undefined });

          // Steering joins the running turn; policy follows the initiating sender (42).
          const steered = await storedTurn([
            {
              role: "user",
              content: "Start",
              timestamp: 1,
              __openclaw: {
                senderIsOwner: false,
                requesterOrigin: { sessionKey: "agent:main:telegram:direct:x", senderId: "42" },
              },
            },
            assistant("Working"),
            {
              role: "user",
              content: "Also check this",
              timestamp: 3,
              __openclaw: {
                steerTargetRunId: "run-1",
                requesterOrigin: { sessionKey: "agent:main:telegram:direct:x", senderId: "7" },
              },
            },
            assistant("Done"),
          ]);
          await expect(fixture.fork(steered, {})).resolves.toEqual({
            ok: true,
            result: { status: "refused", reason: "tool_policy" },
          });

          // No input for the turn: refuse rather than guess the requester.
          const orphan = await storedTurn([assistant("Orphan reply")]);
          await expect(fixture.fork(orphan, {})).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining("no longer holds the input"),
          });
          // A tool-free fork runs nothing, so it proceeds on the session's own facts.
          await expect(fixture.fork(orphan, { tools: [] })).resolves.toMatchObject({
            ok: true,
            result: { status: "settled" },
          });
        },
      );
    },
  );
});
