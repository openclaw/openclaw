import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadCommitmentStore } from "../commitments/store.js";
import { resolveOAuthDir } from "../config/paths.js";
import { loadDeviceAuthStore } from "../infra/device-auth-store.js";
import { listDevicePairing } from "../infra/device-pairing.js";
import { loadApnsRegistration } from "../infra/push-apns.js";
import { listWebPushSubscriptions } from "../infra/push-web.js";
import { readMediaBuffer } from "../media/store.js";
import {
  MEMORY_CORE_DAILY_INGESTION_STATE_NAMESPACE,
  MEMORY_CORE_SESSION_INGESTION_FILES_NAMESPACE,
  MEMORY_CORE_SESSION_INGESTION_MESSAGES_NAMESPACE,
  MEMORY_CORE_SHORT_TERM_META_NAMESPACE,
  MEMORY_CORE_SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  MEMORY_CORE_SHORT_TERM_RECALL_NAMESPACE,
  readDreamingSessionCorpusText,
  readDreamingWorkspaceMap,
  readDreamingWorkspaceValue,
} from "../memory-host-sdk/dreaming-state-store.js";
import { readMemoryHostEvents } from "../memory-host-sdk/events.js";
import { loadNodeHostConfig } from "../node-host/config.js";
import { listChannelPairingRequests, readChannelAllowFromStore } from "../pairing/pairing-store.js";
import { readOpenClawStateKvJson } from "../state/openclaw-state-kv.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";

const noteMock = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note: (...args: unknown[]) => noteMock(...args),
}));

describe("maybeRepairLegacyRuntimeStateFiles", () => {
  let maybeRepairLegacyRuntimeStateFiles: typeof import("./doctor-sqlite-state.js").maybeRepairLegacyRuntimeStateFiles;

  beforeEach(async () => {
    vi.resetModules();
    noteMock.mockReset();
    ({ maybeRepairLegacyRuntimeStateFiles } = await import("./doctor-sqlite-state.js"));
  });

  it("imports legacy runtime JSON files into SQLite during doctor --fix", async () => {
    await withTempDir("openclaw-doctor-sqlite-state-", async (stateDir) => {
      const openClawHome = path.join(stateDir, "home");
      const env = {
        ...process.env,
        OPENCLAW_HOME: openClawHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_FAST: "1",
      };
      await withEnvAsync(env, async () => {
        const execApprovalsPath = path.join(openClawHome, ".openclaw", "exec-approvals.json");
        await fs.mkdir(path.dirname(execApprovalsPath), { recursive: true });
        await fs.writeFile(
          execApprovalsPath,
          `${JSON.stringify({
            version: 1,
            defaults: { security: "allowlist", ask: "on-miss" },
            agents: {},
          })}\n`,
          "utf8",
        );
        await fs.mkdir(path.join(stateDir, "devices"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "devices", "bootstrap.json"),
          `${JSON.stringify({
            "bootstrap-token": {
              token: "bootstrap-token",
              ts: Date.now(),
              issuedAtMs: Date.now(),
            },
          })}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "devices", "pending.json"),
          `${JSON.stringify({
            "request-1": {
              requestId: "request-1",
              deviceId: "device-1",
              publicKey: "public-key",
              role: "operator",
              scopes: ["operator.read"],
              ts: Date.now(),
            },
          })}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "devices", "paired.json"),
          `${JSON.stringify({
            "device-2": {
              deviceId: "device-2",
              publicKey: "public-key-2",
              role: "node",
              roles: ["node"],
              scopes: [],
              approvedScopes: [],
              createdAtMs: 1,
              approvedAtMs: 2,
            },
          })}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "node.json"),
          `${JSON.stringify({
            version: 1,
            nodeId: "legacy-node",
            token: "legacy-node-token",
            displayName: "Legacy Node",
            gateway: { host: "gateway.local", port: 18443, tls: true },
          })}\n`,
          "utf8",
        );
        await fs.mkdir(path.join(stateDir, "identity"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "identity", "device-auth.json"),
          `${JSON.stringify({
            version: 1,
            deviceId: "device-1",
            tokens: {
              operator: {
                token: "local-token",
                role: "operator",
                scopes: ["operator.read"],
                updatedAtMs: 1,
              },
            },
          })}\n`,
          "utf8",
        );
        const oauthDir = resolveOAuthDir(env, stateDir);
        await fs.mkdir(oauthDir, { recursive: true });
        await fs.writeFile(
          path.join(oauthDir, "telegram-pairing.json"),
          `${JSON.stringify({
            version: 1,
            requests: [
              {
                id: "sender-1",
                code: "ABCD1234",
                createdAt: new Date().toISOString(),
                lastSeenAt: new Date().toISOString(),
                meta: { accountId: "default" },
              },
            ],
          })}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(oauthDir, "telegram-default-allowFrom.json"),
          `${JSON.stringify({ version: 1, allowFrom: ["sender-2"] })}\n`,
          "utf8",
        );
        const commitmentsDir = path.join(stateDir, "commitments");
        await fs.mkdir(commitmentsDir, { recursive: true });
        await fs.writeFile(
          path.join(commitmentsDir, "commitments.json"),
          `${JSON.stringify({
            version: 1,
            commitments: [
              {
                id: "cm_legacy",
                agentId: "main",
                sessionKey: "agent:main:telegram:sender-1",
                channel: "telegram",
                kind: "event_check_in",
                sensitivity: "routine",
                source: "inferred_user_context",
                status: "pending",
                reason: "Check in later.",
                suggestedText: "How did it go?",
                dedupeKey: "legacy-check-in",
                confidence: 0.9,
                dueWindow: { earliestMs: 1, latestMs: 2, timezone: "UTC" },
                createdAtMs: 1,
                updatedAtMs: 1,
                attempts: 0,
                sourceUserText: "legacy raw text",
              },
            ],
          })}\n`,
          "utf8",
        );
        await fs.mkdir(path.join(stateDir, "push"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "push", "web-push-subscriptions.json"),
          `${JSON.stringify({
            subscriptionsByEndpointHash: {
              hash: {
                subscriptionId: "sub-1",
                endpoint: "https://push.example/sub",
                keys: { p256dh: "p256dh", auth: "auth" },
                createdAtMs: 1,
                updatedAtMs: 2,
              },
            },
          })}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "push", "apns-registrations.json"),
          `${JSON.stringify({
            registrationsByNodeId: {
              "ios-node": {
                nodeId: "ios-node",
                token: "abcd1234abcd1234abcd1234abcd1234",
                topic: "ai.openclaw.ios",
                environment: "sandbox",
                updatedAtMs: 1,
              },
            },
          })}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "update-check.json"),
          `${JSON.stringify({
            lastCheckedAt: "2026-01-17T10:00:00.000Z",
            lastAvailableVersion: "2.0.0",
            lastAvailableTag: "latest",
          })}\n`,
          "utf8",
        );
        await fs.mkdir(path.join(stateDir, "logs"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "logs", "config-health.json"),
          `${JSON.stringify({
            entries: {
              "/tmp/openclaw.json": {
                lastKnownGood: {
                  hash: "legacy-health",
                  bytes: 42,
                  mtimeMs: 1,
                  ctimeMs: 1,
                  dev: null,
                  ino: null,
                  mode: 384,
                  nlink: 1,
                  uid: null,
                  gid: null,
                  hasMeta: true,
                  gatewayMode: "local",
                  observedAt: "2026-01-17T10:00:00.000Z",
                },
              },
            },
          })}\n`,
          "utf8",
        );
        const mediaRecordsDir = path.join(stateDir, "media", "outgoing", "records");
        await fs.mkdir(mediaRecordsDir, { recursive: true });
        await fs.writeFile(
          path.join(mediaRecordsDir, "11111111-1111-4111-8111-111111111111.json"),
          `${JSON.stringify({
            attachmentId: "11111111-1111-4111-8111-111111111111",
            sessionKey: "agent:main:main",
            messageId: "msg-1",
            createdAt: "2026-01-17T10:00:00.000Z",
            alt: "legacy image",
            original: {
              path: "/tmp/legacy-image.png",
              contentType: "image/png",
              width: 1,
              height: 1,
              sizeBytes: 1,
              filename: "legacy-image.png",
            },
          })}\n`,
          "utf8",
        );
        const legacyMediaDir = path.join(stateDir, "media", "inbound");
        await fs.mkdir(legacyMediaDir, { recursive: true });
        await fs.writeFile(path.join(legacyMediaDir, "legacy-media.txt"), "legacy media", "utf8");
        await fs.mkdir(path.join(stateDir, "subagents"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "subagents", "runs.json"),
          `${JSON.stringify({
            version: 2,
            runs: {
              "run-legacy": {
                runId: "run-legacy",
                childSessionKey: "agent:main:subagent:legacy",
                requesterSessionKey: "agent:main:main",
                requesterDisplayKey: "main",
                task: "legacy task",
                cleanup: "keep",
                createdAt: 1,
                startedAt: 2,
                spawnMode: "run",
              },
            },
          })}\n`,
          "utf8",
        );
        await fs.mkdir(path.join(stateDir, "tui"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "tui", "last-session.json"),
          `${JSON.stringify({
            "legacy-tui-scope": {
              sessionKey: "agent:main:tui-legacy",
              updatedAt: 1000,
            },
          })}\n`,
          "utf8",
        );
        await fs.mkdir(path.join(stateDir, "settings"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "settings", "voicewake.json"),
          `${JSON.stringify({
            triggers: ["  wake ", ""],
            updatedAtMs: 11,
          })}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "settings", "voicewake-routing.json"),
          `${JSON.stringify({
            defaultTarget: { mode: "current" },
            routes: [{ trigger: "  Robot   Wake ", target: { agentId: "main" } }],
            updatedAtMs: 12,
          })}\n`,
          "utf8",
        );
        const agentDir = path.join(stateDir, "agents", "main", "agent");
        await fs.mkdir(agentDir, { recursive: true });
        const authStatePath = path.join(agentDir, "auth-state.json");
        await fs.writeFile(
          authStatePath,
          `${JSON.stringify({
            version: 1,
            order: { openai: ["openai:default"] },
            lastGood: { openai: "openai:default" },
          })}\n`,
          "utf8",
        );
        await fs.mkdir(path.join(stateDir, "cache"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "cache", "openrouter-models.json"),
          `${JSON.stringify({
            models: {
              "acme/legacy": {
                name: "Legacy OpenRouter",
                input: ["text"],
                reasoning: false,
                contextWindow: 123,
                maxTokens: 456,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            },
          })}\n`,
          "utf8",
        );
        await fs.mkdir(path.join(stateDir, "plugins"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "plugins", "installs.json"),
          `${JSON.stringify({
            version: 1,
            warning: "DO NOT EDIT.",
            hostContractVersion: "2026.4.25",
            compatRegistryVersion: "compat-v1",
            migrationVersion: 1,
            policyHash: "policy-v1",
            generatedAtMs: 1777118400000,
            installRecords: {
              "legacy-plugin": {
                source: "npm",
                spec: "legacy-plugin@1.0.0",
              },
            },
            plugins: [
              {
                pluginId: "legacy-plugin",
                manifestPath: "/plugins/legacy/openclaw.plugin.json",
                manifestHash: "manifest-hash",
                rootDir: "/plugins/legacy",
                origin: "global",
                enabled: true,
                startup: {
                  sidecar: false,
                  memory: false,
                  deferConfiguredChannelFullLoadUntilAfterListen: false,
                  agentHarnesses: [],
                },
                compat: [],
              },
            ],
            diagnostics: [],
          })}\n`,
          "utf8",
        );

        await maybeRepairLegacyRuntimeStateFiles({
          prompter: { shouldRepair: true },
          env,
        });

        expect(noteMock).toHaveBeenCalledWith(
          expect.stringContaining("Imported"),
          "Doctor changes",
        );
        await expect(listDevicePairing(stateDir)).resolves.toMatchObject({
          pending: [expect.objectContaining({ requestId: "request-1" })],
          paired: [expect.objectContaining({ deviceId: "device-2" })],
        });
        await expect(loadNodeHostConfig(env)).resolves.toMatchObject({
          nodeId: "legacy-node",
          token: "legacy-node-token",
          displayName: "Legacy Node",
          gateway: { host: "gateway.local", port: 18443, tls: true },
        });
        expect(readOpenClawStateKvJson("exec.approvals", "current", { env })).toContain(
          '"security":"allowlist"',
        );
        await expect(fs.stat(execApprovalsPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(path.join(stateDir, "node.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(loadDeviceAuthStore({ env })?.tokens.operator?.token).toBe("local-token");
        await expect(listChannelPairingRequests("telegram", env, "default")).resolves.toEqual([
          expect.objectContaining({ id: "sender-1", code: "ABCD1234" }),
        ]);
        await expect(readChannelAllowFromStore("telegram", env, "default")).resolves.toEqual([
          "sender-2",
        ]);
        await expect(fs.stat(path.join(oauthDir, "telegram-pairing.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(
          fs.stat(path.join(oauthDir, "telegram-default-allowFrom.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(loadCommitmentStore()).resolves.toEqual({
          version: 1,
          commitments: [
            expect.objectContaining({
              id: "cm_legacy",
              dedupeKey: "legacy-check-in",
            }),
          ],
        });
        expect((await loadCommitmentStore()).commitments[0]).not.toHaveProperty("sourceUserText");
        await expect(fs.stat(path.join(commitmentsDir, "commitments.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(listWebPushSubscriptions(stateDir)).resolves.toEqual([
          expect.objectContaining({ subscriptionId: "sub-1" }),
        ]);
        await expect(loadApnsRegistration("ios-node", stateDir)).resolves.toMatchObject({
          nodeId: "ios-node",
        });
        expect(readOpenClawStateKvJson("runtime.update-check", "state", { env })).toMatchObject({
          lastAvailableVersion: "2.0.0",
          lastAvailableTag: "latest",
        });
        await expect(fs.stat(path.join(stateDir, "update-check.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(readOpenClawStateKvJson("config.health", "current", { env })).toMatchObject({
          entries: {
            "/tmp/openclaw.json": {
              lastKnownGood: {
                hash: "legacy-health",
                gatewayMode: "local",
              },
            },
          },
        });
        await expect(
          fs.stat(path.join(stateDir, "logs", "config-health.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          readOpenClawStateKvJson(
            "managed_outgoing_image_records",
            "11111111-1111-4111-8111-111111111111",
            { env },
          ),
        ).toMatchObject({
          sessionKey: "agent:main:main",
          alt: "legacy image",
        });
        await expect(
          fs.stat(path.join(mediaRecordsDir, "11111111-1111-4111-8111-111111111111.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readMediaBuffer("legacy-media.txt", "inbound")).resolves.toMatchObject({
          id: "legacy-media.txt",
          size: "legacy media".length,
        });
        await expect(fs.stat(path.join(legacyMediaDir, "legacy-media.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(readOpenClawStateKvJson("subagent_runs", "run-legacy", { env })).toMatchObject({
          childSessionKey: "agent:main:subagent:legacy",
        });
        await expect(fs.stat(path.join(stateDir, "subagents", "runs.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(readOpenClawStateKvJson("tui:last-session", "legacy-tui-scope", { env })).toEqual({
          sessionKey: "agent:main:tui-legacy",
          updatedAt: 1000,
        });
        await expect(
          fs.stat(path.join(stateDir, "tui", "last-session.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(readOpenClawStateKvJson("voicewake", "triggers", { env })).toMatchObject({
          triggers: ["wake"],
        });
        await expect(
          fs.stat(path.join(stateDir, "settings", "voicewake.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(readOpenClawStateKvJson("voicewake", "routing", { env })).toMatchObject({
          routes: [{ trigger: "robot wake", target: { agentId: "main" } }],
        });
        await expect(
          fs.stat(path.join(stateDir, "settings", "voicewake-routing.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(readOpenClawStateKvJson("auth-profile-state", authStatePath, { env })).toMatchObject(
          {
            order: { openai: ["openai:default"] },
            lastGood: { openai: "openai:default" },
          },
        );
        await expect(fs.stat(authStatePath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          readOpenClawStateKvJson("openrouter_model_capabilities", "models", { env }),
        ).toMatchObject({
          models: {
            "acme/legacy": {
              name: "Legacy OpenRouter",
              contextWindow: 123,
              maxTokens: 456,
            },
          },
        });
        await expect(
          fs.stat(path.join(stateDir, "cache", "openrouter-models.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(readOpenClawStateKvJson("installed_plugin_index", "current", { env })).toMatchObject(
          {
            installRecords: {
              "legacy-plugin": {
                source: "npm",
                spec: "legacy-plugin@1.0.0",
              },
            },
            plugins: [expect.objectContaining({ pluginId: "legacy-plugin" })],
          },
        );
        await expect(
          fs.stat(path.join(stateDir, "plugins", "installs.json")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    });
  });

  it("imports memory-core dreaming checkpoint files from configured workspaces", async () => {
    await withTempDir("openclaw-doctor-memory-core-state-", async (rootDir) => {
      const stateDir = path.join(rootDir, "state");
      const workspaceDir = path.join(rootDir, "workspace");
      const dreamsDir = path.join(workspaceDir, "memory", ".dreams");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" };
      const cfg = {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
      };
      await withEnvAsync(env, async () => {
        await fs.mkdir(dreamsDir, { recursive: true });
        await fs.writeFile(
          path.join(dreamsDir, "daily-ingestion.json"),
          `${JSON.stringify({
            version: 1,
            updatedAt: "2026-04-05T10:00:00.000Z",
            files: {
              "memory/2026-04-05.md": {
                mtimeMs: 1,
                size: 2,
                contentHash: "daily-hash",
              },
            },
          })}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(dreamsDir, "session-ingestion.json"),
          `${JSON.stringify({
            version: 3,
            updatedAt: "2026-04-05T11:00:00.000Z",
            files: {
              "main:sessions/main/dreaming-main.jsonl": {
                mtimeMs: 3,
                size: 4,
                contentHash: "session-hash",
                lineCount: 1,
                lastContentLine: 1,
              },
            },
            seenMessages: {
              "main:sessions/main/dreaming-main.jsonl": ["message-hash"],
            },
          })}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(dreamsDir, "short-term-recall.json"),
          `${JSON.stringify({
            version: 1,
            updatedAt: "2026-04-05T12:00:00.000Z",
            entries: {
              recall_key: {
                key: "recall_key",
                path: "memory/2026-04-03.md",
                startLine: 1,
                endLine: 1,
                source: "memory",
                snippet: "Move backups to S3 Glacier.",
                recallCount: 1,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 0.91,
                maxScore: 0.91,
                firstRecalledAt: "2026-04-05T12:00:00.000Z",
                lastRecalledAt: "2026-04-05T12:00:00.000Z",
                queryHashes: ["query-hash"],
                recallDays: ["2026-04-05"],
                conceptTags: ["backup"],
              },
            },
          })}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(dreamsDir, "phase-signals.json"),
          `${JSON.stringify({
            version: 1,
            updatedAt: "2026-04-05T13:00:00.000Z",
            entries: {
              recall_key: {
                key: "recall_key",
                lightHits: 1,
                remHits: 1,
                lastLightAt: "2026-04-05T12:30:00.000Z",
                lastRemAt: "2026-04-05T13:00:00.000Z",
              },
            },
          })}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(dreamsDir, "events.jsonl"),
          `${JSON.stringify({
            type: "memory.recall.recorded",
            timestamp: "2026-04-05T14:00:00.000Z",
            query: "legacy doctor event",
            resultCount: 0,
            results: [],
          })}\n`,
          "utf8",
        );
        const sessionCorpusDir = path.join(dreamsDir, "session-corpus");
        await fs.mkdir(sessionCorpusDir, { recursive: true });
        await fs.writeFile(
          path.join(sessionCorpusDir, "2026-04-05.txt"),
          "User: Move backups to S3 Glacier.\nAssistant: Retention stays at 365 days.\n",
          "utf8",
        );
        await fs.writeFile(path.join(dreamsDir, "short-term-promotion.lock"), "999999:0\n", "utf8");

        await maybeRepairLegacyRuntimeStateFiles({
          prompter: { shouldRepair: true },
          env,
          cfg,
        });

        expect(noteMock).toHaveBeenCalledWith(
          expect.stringContaining("memory-core dreaming checkpoint row"),
          "Doctor changes",
        );
        await expect(fs.stat(path.join(dreamsDir, "daily-ingestion.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(fs.stat(path.join(dreamsDir, "session-ingestion.json"))).rejects.toMatchObject(
          { code: "ENOENT" },
        );
        await expect(fs.stat(path.join(dreamsDir, "short-term-recall.json"))).rejects.toMatchObject(
          { code: "ENOENT" },
        );
        await expect(fs.stat(path.join(dreamsDir, "phase-signals.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(fs.stat(path.join(dreamsDir, "events.jsonl"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(fs.stat(path.join(sessionCorpusDir, "2026-04-05.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(
          fs.stat(path.join(dreamsDir, "short-term-promotion.lock")),
        ).rejects.toMatchObject({ code: "ENOENT" });

        await expect(
          readDreamingWorkspaceMap(MEMORY_CORE_DAILY_INGESTION_STATE_NAMESPACE, workspaceDir),
        ).resolves.toMatchObject({
          "memory/2026-04-05.md": { contentHash: "daily-hash" },
        });
        await expect(
          readDreamingWorkspaceMap(MEMORY_CORE_SESSION_INGESTION_FILES_NAMESPACE, workspaceDir),
        ).resolves.toMatchObject({
          "main:sessions/main/dreaming-main.jsonl": { contentHash: "session-hash" },
        });
        await expect(
          readDreamingWorkspaceMap(MEMORY_CORE_SESSION_INGESTION_MESSAGES_NAMESPACE, workspaceDir),
        ).resolves.toEqual({
          "main:sessions/main/dreaming-main.jsonl": ["message-hash"],
        });
        await expect(
          readDreamingWorkspaceMap(MEMORY_CORE_SHORT_TERM_RECALL_NAMESPACE, workspaceDir),
        ).resolves.toMatchObject({
          recall_key: { snippet: "Move backups to S3 Glacier." },
        });
        await expect(
          readDreamingWorkspaceMap(MEMORY_CORE_SHORT_TERM_PHASE_SIGNAL_NAMESPACE, workspaceDir),
        ).resolves.toMatchObject({
          recall_key: { lightHits: 1, remHits: 1 },
        });
        await expect(
          readDreamingWorkspaceValue(MEMORY_CORE_SHORT_TERM_META_NAMESPACE, workspaceDir, "recall"),
        ).resolves.toEqual({ updatedAt: "2026-04-05T12:00:00.000Z" });
        await expect(
          readDreamingWorkspaceValue(
            MEMORY_CORE_SHORT_TERM_META_NAMESPACE,
            workspaceDir,
            "phase-signals",
          ),
        ).resolves.toEqual({ updatedAt: "2026-04-05T13:00:00.000Z" });
        await expect(readMemoryHostEvents({ workspaceDir, env })).resolves.toMatchObject([
          {
            type: "memory.recall.recorded",
            query: "legacy doctor event",
          },
        ]);
        await expect(
          readDreamingSessionCorpusText({
            workspaceDir,
            relativePath: "memory/.dreams/session-corpus/2026-04-05.txt",
            env,
          }),
        ).resolves.toBe(
          "User: Move backups to S3 Glacier.\nAssistant: Retention stays at 365 days.\n",
        );
      });
    });
  });

  it("imports legacy memory-core session corpus when it is the only dreaming file", async () => {
    await withTempDir("openclaw-doctor-memory-core-corpus-", async (rootDir) => {
      const stateDir = path.join(rootDir, "state");
      const workspaceDir = path.join(rootDir, "workspace");
      const sessionCorpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" };
      const cfg = {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
      };
      await withEnvAsync(env, async () => {
        await fs.mkdir(sessionCorpusDir, { recursive: true });
        await fs.writeFile(
          path.join(sessionCorpusDir, "2026-04-06.txt"),
          "User: Store the legacy corpus in SQLite.\n",
          "utf8",
        );

        await maybeRepairLegacyRuntimeStateFiles({
          prompter: { shouldRepair: true },
          env,
          cfg,
        });

        expect(noteMock).toHaveBeenCalledWith(
          expect.stringContaining("memory-core dreaming checkpoint row"),
          "Doctor changes",
        );
        await expect(fs.stat(path.join(sessionCorpusDir, "2026-04-06.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(
          readDreamingSessionCorpusText({
            workspaceDir,
            relativePath: "memory/.dreams/session-corpus/2026-04-06.txt",
            env,
          }),
        ).resolves.toBe("User: Store the legacy corpus in SQLite.\n");
      });
    });
  });
});
