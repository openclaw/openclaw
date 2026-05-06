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
      });
    });
  });
});
