import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadCommitmentStore } from "../commitments/store.js";
import { resolveOAuthDir } from "../config/paths.js";
import { loadDeviceAuthStore } from "../infra/device-auth-store.js";
import { listDevicePairing } from "../infra/device-pairing.js";
import { loadApnsRegistration } from "../infra/push-apns.js";
import { listWebPushSubscriptions } from "../infra/push-web.js";
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
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" };
      await withEnvAsync(env, async () => {
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
      });
    });
  });
});
