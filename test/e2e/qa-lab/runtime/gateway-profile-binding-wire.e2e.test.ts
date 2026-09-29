import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  buildQaGatewayConfig,
  startQaMockOpenAiServer,
  type MockOpenAiRequestSnapshot,
} from "../../../../extensions/qa-lab/api.js";
import type { OpenClawTestInstance } from "../../../helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { MODEL_REF, PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import { startHeldResponsesProvider } from "./held-responses-provider.js";
import { wireMessageText } from "./paired-node-worker-wire-fixture.js";
import {
  createSkillLibraryWireInstance,
  SKILL_LIBRARY_ALICE,
  SKILL_LIBRARY_BOB,
  SKILL_LIBRARY_WRITER_SCOPES,
  SkillLibraryWireClient,
} from "./skill-library-wire-fixture.js";

const REQUEST_TIMEOUT_MS = 30_000;
const CUSTODY_REPLY = "PROFILE-AGENT-CUSTODY-OK";
type WireProvider = { baseUrl: string; stop(): Promise<void>; release?: () => void };
type Self = { profile: { id: string } };
type HistoryMessage = { role?: string; content?: unknown };

async function history(client: SkillLibraryWireClient, sessionKey: string) {
  return (
    await client.request<{ messages: HistoryMessage[] }>("chat.history", {
      sessionKey,
      limit: 100,
    })
  ).messages;
}

async function expectOpenClawRuntime(client: SkillLibraryWireClient, key: string) {
  await expect(client.request("sessions.describe", { key })).resolves.toMatchObject({
    session: { key, agentRuntime: { id: "openclaw" } },
  });
}

async function runProfileWireProof<P extends WireProvider>(
  startProvider: () => Promise<P>,
  proof: (fixture: {
    instance: OpenClawTestInstance;
    provider: P;
    admin: SkillLibraryWireClient;
    alice: SkillLibraryWireClient;
    bob: SkillLibraryWireClient;
    aliceId: string;
    bobId: string;
    reconnectAlice: () => Promise<SkillLibraryWireClient>;
    createSession: (suffix: string) => Promise<string>;
  }) => Promise<void>,
) {
  const instance = await createSkillLibraryWireInstance();
  let provider: P | undefined;
  const clients: SkillLibraryWireClient[] = [];
  await runQaGatewayFixture(
    async () => {
      // Keep fixture-owned selectors and OS launch inputs, never inherited operator credentials.
      const childEnvKeys = new Set([
        ...Object.keys(instance.state.envVars),
        "PATH",
        "Path",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
        "ComSpec",
        "COMSPEC",
        "PATHEXT",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
        "OPENCLAW_GATEWAY_PORT",
        "OPENCLAW_GATEWAY_URL",
        "OPENCLAW_SKIP_GMAIL_WATCHER",
        "OPENCLAW_SKIP_CRON",
        "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
        "OPENCLAW_SKIP_CANVAS_HOST",
      ]);
      for (const key of Object.keys(instance.env)) {
        if (!childEnvKeys.has(key)) {
          delete instance.env[key];
        }
      }
      provider = await startProvider();
      const authConfig = JSON.parse(
        await fs.readFile(instance.configPath, "utf8"),
      ) as OpenClawConfig;
      const config = buildQaGatewayConfig({
        bind: "loopback",
        gatewayPort: instance.port,
        gatewayToken: instance.gatewayToken,
        workspaceDir: instance.state.workspaceDir,
        providerBaseUrl: `${provider.baseUrl}/v1`,
        providerMode: "mock-openai",
        primaryModel: MODEL_REF,
        alternateModel: MODEL_REF,
        controlUiEnabled: false,
        enabledPluginIds: ["openai"],
      });
      await instance.state.writeConfig({
        ...config,
        // Preserve the proxy identity and scope caps, not just the auth-mode field.
        gateway: authConfig.gateway,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            models: {
              ...config.agents?.defaults?.models,
              [MODEL_REF]: {
                ...config.agents?.defaults?.models?.[MODEL_REF],
                agentRuntime: { id: "openclaw" },
              },
            },
          },
        },
        tools: { ...config.tools, codeMode: false, exec: { mode: "full" } },
      });
      await instance.startGateway();
      const connect = async (options?: Parameters<typeof SkillLibraryWireClient.connect>[1]) => {
        const connected = await SkillLibraryWireClient.connect(instance, options);
        clients.push(connected.client);
        return connected;
      };
      const { client: admin, hello } = await connect();
      expect(hello.auth?.scopes).toContain("operator.admin");
      const { client: aliceAdmin, hello: aliceAdminHello } = await connect({
        email: SKILL_LIBRARY_ALICE,
        scopes: ["operator.admin", ...SKILL_LIBRARY_WRITER_SCOPES],
        buildId: hello.server.buildId,
      });
      expect(aliceAdminHello.auth?.scopes).toContain("operator.admin");
      const connectWriter = async (email: string) => {
        const connected = await connect({ email, buildId: hello.server.buildId });
        expect(connected.hello.auth?.scopes?.toSorted()).toEqual(
          [...SKILL_LIBRARY_WRITER_SCOPES].toSorted(),
        );
        return connected.client;
      };
      const alice = await connectWriter(SKILL_LIBRARY_ALICE);
      const bob = await connectWriter(SKILL_LIBRARY_BOB);
      const aliceId = (await alice.request<Self>("users.self", {})).profile.id;
      const bobId = (await bob.request<Self>("users.self", {})).profile.id;
      expect(aliceId).toEqual(expect.any(String));
      expect(aliceId.length).toBeGreaterThan(0);
      expect(bobId).toEqual(expect.any(String));
      expect(bobId.length).toBeGreaterThan(0);
      expect(aliceId).not.toBe(bobId);
      await proof({
        instance,
        provider,
        admin,
        alice,
        bob,
        aliceId,
        bobId,
        reconnectAlice: () => connectWriter(SKILL_LIBRARY_ALICE),
        createSession: async (suffix) => {
          const key = `agent:qa:profile-binding-${suffix}`;
          await aliceAdmin.request("sessions.create", {
            key,
            agentId: "qa",
            displayName: `Profile binding ${suffix}`,
            visibility: "shared",
            permissionMode: "full",
            worktree: false,
            cwd: instance.state.workspaceDir,
          });
          // Both authenticated writers can reach this session independently of binding.
          for (const client of [alice, bob]) {
            await expectOpenClawRuntime(client, key);
            expect(await history(client, key)).toEqual([]);
          }
          return key;
        },
      });
    },
    () => provider?.release?.(),
    () =>
      runQaGatewayFixture(
        async () => {},
        ...clients.toReversed().map((client) => () => client.close()),
      ),
    () => instance.cleanup(),
    () => provider?.stop(),
  );
}

async function expectMismatch(operation: Promise<unknown>) {
  await expect(operation).rejects.toMatchObject({
    error: {
      code: "INVALID_REQUEST",
      details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "not_started" },
    },
  });
}

describe("profile binding through an authenticated child Gateway", () => {
  it(
    "fences rejected tool effects before and after a real profile merge on the original socket",
    { timeout: 240_000 },
    async () => {
      await runProfileWireProof(
        () => startQaMockOpenAiServer({ modelRefs: [MODEL_REF] }),
        async ({ instance, provider, admin, alice, aliceId, bobId, createSession }) => {
          const key = await createSession("effects");
          const journal = async (): Promise<MockOpenAiRequestSnapshot[]> => {
            const response = await fetch(`${provider.baseUrl}/debug/requests?after=0`, {
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            expect(response.ok).toBe(true);
            return await response.json();
          };
          const turn = (marker: string) => {
            const sentinel = path.join(instance.state.workspaceDir, `${marker}.txt`);
            const command = `printf '%s' ${JSON.stringify(marker)} >> ${JSON.stringify(sentinel)}`;
            return {
              sentinel,
              command,
              params: {
                sessionKey: key,
                message: [
                  "Tool progress QA check.",
                  `Call the exec tool exactly once with this exact command before answering: \`${command}\`.`,
                  `Reply exactly \`${marker}\`.`,
                ].join(" "),
                deliver: false,
                idempotencyKey: marker,
              },
            };
          };
          const rejectTurn = async (marker: string, expectedProfileId: string) => {
            const rejected = turn(marker);
            const original = "UNCHANGED";
            await fs.writeFile(rejected.sentinel, original);
            const beforeHistory = await history(alice, key);
            const beforeJournal = await journal();
            await expectMismatch(
              alice.request("chat.send", rejected.params, REQUEST_TIMEOUT_MS, {
                expectedProfileId,
              }),
            );
            expect(await history(alice, key)).toEqual(beforeHistory);
            expect(await journal()).toEqual(beforeJournal);
            const unchanged = async () => {
              expect(await fs.readFile(rejected.sentinel, "utf8")).toBe(original);
              expect(
                (await history(alice, key)).filter((message) =>
                  wireMessageText(message).includes(marker),
                ),
              ).toEqual([]);
              expect((await journal()).filter((request) => request.raw.includes(marker))).toEqual(
                [],
              );
            };
            await unchanged();
            return unchanged;
          };
          const allowedTurn = async (marker: string, expectedProfileId?: string) => {
            const allowed = turn(marker);
            await expect(
              alice.request("chat.send", allowed.params, REQUEST_TIMEOUT_MS, {
                expectedProfileId,
              }),
            ).resolves.toMatchObject({ runId: marker, status: "started" });
            await expect(
              alice.request(
                "agent.wait",
                { runId: marker, timeoutMs: PROOF_TIMEOUT_MS },
                PROOF_TIMEOUT_MS + 5_000,
              ),
            ).resolves.toMatchObject({ status: "ok" });
            await vi.waitFor(
              async () => {
                const replies = (await history(alice, key)).filter(
                  (message) => message.role === "assistant" && wireMessageText(message) === marker,
                );
                expect(replies).toHaveLength(1);
              },
              { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
            );
            expect(await fs.readFile(allowed.sentinel, "utf8")).toBe(marker);
            const requests = (await journal()).filter((request) => request.prompt.includes(marker));
            expect(
              requests.some(
                (request) =>
                  request.plannedToolName === "exec" &&
                  request.plannedToolArgs?.command === allowed.command,
              ),
            ).toBe(true);
            expect(
              requests.some(
                (request) =>
                  request.requestKind === "tool-continuation" && request.outcome === "success",
              ),
            ).toBe(true);
            await expectOpenClawRuntime(alice, key);
          };

          const unchangedWrongAccount = await rejectTurn("PROFILE-WRONG-ACCOUNT", bobId);
          await allowedTurn("PROFILE-BOUND-ALLOWED", aliceId);
          await allowedTurn("PROFILE-OMITTED-ALLOWED");
          await unchangedWrongAccount();
          await admin.request("users.linkEmail", {
            email: SKILL_LIBRARY_ALICE,
            targetProfileId: bobId,
          });
          await expect(alice.request<Self>("users.self", {})).resolves.toMatchObject({
            profile: { id: bobId },
          });
          const unchangedOldSelection = await rejectTurn("PROFILE-STALE-SELECTION", aliceId);
          await allowedTurn("PROFILE-MERGED-ALLOWED", bobId);
          // Check again after later successful work so deferred execution cannot pass unnoticed.
          await unchangedWrongAccount();
          await unchangedOldSelection();
        },
      );
    },
  );

  it(
    "retains accepted agent custody across reconnect and rejects a mismatched profile binding",
    { timeout: 180_000 },
    async () => {
      await runProfileWireProof(
        () => startHeldResponsesProvider({ modelRef: MODEL_REF, terminalText: CUSTODY_REPLY }),
        async ({ provider, alice, aliceId, bobId, reconnectAlice, createSession }) => {
          const key = await createSession("agent-custody");
          const runId = "profile-agent-custody";
          const message = `Return exactly ${CUSTODY_REPLY}.`;
          const params = { sessionKey: key, message, deliver: false, idempotencyKey: runId };
          const binding = { expectedProfileId: aliceId };
          await expect(
            alice.request("agent", params, REQUEST_TIMEOUT_MS, binding),
          ).resolves.toMatchObject({ status: "accepted", runId });
          await vi.waitFor(() => expect(provider.requests).toHaveLength(1), {
            timeout: REQUEST_TIMEOUT_MS,
            interval: 20,
          });
          await vi.waitFor(
            async () => {
              const messages = await history(alice, key);
              expect(messages.map((entry) => entry.role)).toEqual(["user"]);
              expect(wireMessageText(messages[0])).toContain(message);
            },
            { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
          );
          await expectOpenClawRuntime(alice, key);
          const committed = await history(alice, key);
          await alice.close();

          const reconnected = await reconnectAlice();
          await expect(reconnected.request<Self>("users.self", {})).resolves.toMatchObject({
            profile: { id: aliceId },
          });
          // request() generates a fresh wire ID; method, params and idempotency key stay identical.
          await expect(
            reconnected.request("agent", params, REQUEST_TIMEOUT_MS, binding),
          ).resolves.toMatchObject({ status: "in_flight", runId, sessionKey: key });
          await expectMismatch(
            reconnected.request("agent", params, REQUEST_TIMEOUT_MS, {
              expectedProfileId: bobId,
            }),
          );
          expect(provider.requests).toHaveLength(1);
          expect(await history(reconnected, key)).toEqual(committed);
          provider.release();
          await expect(
            reconnected.request(
              "agent.wait",
              { runId, timeoutMs: PROOF_TIMEOUT_MS },
              PROOF_TIMEOUT_MS + 5_000,
            ),
          ).resolves.toMatchObject({ status: "ok", runId });
          await vi.waitFor(
            async () => {
              const messages = await history(reconnected, key);
              expect(messages.map((entry) => entry.role)).toEqual(["user", "assistant"]);
              expect(wireMessageText(messages[0])).toContain(message);
              expect(wireMessageText(messages[1])).toBe(CUSTODY_REPLY);
            },
            { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
          );
          const terminalHistory = await history(reconnected, key);
          await expect(
            reconnected.request("agent", params, REQUEST_TIMEOUT_MS, binding),
          ).resolves.toMatchObject({
            status: "ok",
            runId,
            result: { payloads: [{ text: CUSTODY_REPLY }] },
          });
          expect(provider.requests).toHaveLength(1);
          expect(JSON.stringify(provider.requests[0])).toContain(message);
          expect(await history(reconnected, key)).toEqual(terminalHistory);
          await expectOpenClawRuntime(reconnected, key);
        },
      );
    },
  );
});
