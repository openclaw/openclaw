import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { QuestionGetResult, QuestionRecord } from "../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { linkUserChannelIdentity } from "../src/state/user-channel-identities.js";
import {
  changeCanonicalUserChannelIdentity,
  publishCanonicalUserChannelPolicy,
} from "../src/state/user-channel-identity-operations.js";
import { setUserProfileRole } from "../src/state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../src/state/user-profiles.js";
import { withEnvAsync } from "../src/test-utils/env.js";
import { createDurableQuestionTelegram } from "./fixtures/durable-question-telegram.js";
import { createDurableQuestionGateway } from "./helpers/durable-question-gateway.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

it.for(["allow", "unlink", "queued-allow", "queued-unlink", "queued-reassign"] as const)(
  "restores bundled Telegram question custody through a local Bot API with %s sender authority",
  { timeout: 180_000 },
  async (authority, { signal }) => {
    const queued = authority.startsWith("queued-");
    const refused =
      authority === "unlink" || authority === "queued-unlink" || authority === "queued-reassign";
    let stage = "not started";
    const setStage = (next: string) => {
      if (next === stage) {
        return;
      }
      stage = next;
      try {
        process.stderr.write(`[durable-question:channel] ${stage}\n`);
      } catch {}
    };
    setStage("channel fixture preparation");
    const telegram = await createDurableQuestionTelegram(signal);
    const { deliveries, recipients } = telegram;
    const gateway: NonNullable<OpenClawConfig["gateway"]> = {
      roles: {
        default: "member",
        definitions: {
          admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
          member: {
            scopes: ["operator.read", "operator.write"],
            agents: "*",
            sessions: { others: "view" },
          },
        },
      },
    };
    const fixture = await createDurableQuestionGateway(signal, {
      continuationToolEffect: queued,
      config: {
        plugins: { allow: ["telegram"], entries: { telegram: { enabled: true } } },
        channels: {
          telegram: {
            enabled: true,
            accounts: {
              team: {
                botToken: telegram.token,
                apiRoot: telegram.apiRoot,
                dmPolicy: "allowlist",
                allowFrom: [telegram.senderId],
                streaming: { mode: "off" },
              },
            },
          },
        },
        gateway,
      },
    }).catch(async (error: unknown) => {
      try {
        await telegram.close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Telegram fixture preparation failed", {
          cause: cleanupError,
        });
      }
      throw error;
    });
    let client: Awaited<ReturnType<typeof fixture.connect>> | undefined;
    const requested = createDeferred<QuestionRecord>();
    let profileId = "";
    let successorProfileId = "";
    const report = () => {
      const diagnostic = `Synthetic channel proof failed during ${stage}.\n${fixture.diagnostics()}\n${fixture.instance.logs()}`;
      try {
        process.stderr.write(`${diagnostic}\n`);
      } catch {}
      return diagnostic;
    };
    const onAbort = () => {
      report();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    await runQaGatewayFixture(
      async () => {
        try {
          setStage("sender identity preparation");
          await withEnvAsync(fixture.instance.state.envVars, async () => {
            const profile = ensureProfileForEmail("channel-proof@example.test");
            profileId = profile.id;
            setUserProfileRole(profile.id, "admin");
            if (authority === "queued-reassign") {
              const successor = ensureProfileForEmail("channel-successor@example.test");
              successorProfileId = successor.id;
              setUserProfileRole(successor.id, "admin");
            }
            linkUserChannelIdentity(profile.id, {
              channelId: "telegram",
              accountId: "team",
              senderId: telegram.senderId,
            });
            await publishCanonicalUserChannelPolicy(gateway);
          });
          setStage("Gateway startup");
          await fixture.instance.startGateway();
          setStage("operator connection");
          client = await fixture.connect(({ event, payload }) => {
            if (event === "question.requested" && isRecord(payload)) {
              requested.resolve(payload as QuestionRecord);
            }
          });
          setStage("Telegram polling readiness");
          await withinTest(Promise.race([telegram.ready, fixture.failed]), signal);
          setStage("Telegram ingress and question publication");
          telegram.send("DURABLE_ASK_PROOF: ask which environment and continue after the answer");
          const question = await withinTest(
            Promise.race([requested.promise, fixture.failed]),
            signal,
          );
          expect(question.sessionKey).toEqual(expect.any(String));
          setStage("canonical durable acceptance");
          expect(
            (
              await client.request<QuestionGetResult>("question.get", {
                id: question.id,
                includeContinuation: true,
              })
            ).continuation,
          ).toMatchObject({ questionId: question.id, status: "pending" });
          setStage("asking turn handoff and prompt delivery");
          await vi.waitFor(() => expect(deliveries.join("\n")).toContain("Which environment?"), {
            timeout: 30_000,
          });
          expect(
            recipients[deliveries.findIndex((text) => text.includes("Which environment?"))],
          ).toBe(telegram.senderId);
          setStage("original operator client retirement");
          await client.stopAndWait();
          client = undefined;
          setStage("Gateway restart and sender authority change");
          await fixture.instance.stopGateway();
          if (authority === "unlink") {
            await withEnvAsync(fixture.instance.state.envVars, () =>
              changeCanonicalUserChannelIdentity("unlink", profileId, {
                channelId: "telegram",
                accountId: "team",
                senderId: telegram.senderId,
              }),
            );
          }
          setStage("restored Gateway startup");
          await fixture.instance.startGateway();
          let resolutionEvents = 0;
          const terminalReceiptPublished = createDeferred();
          setStage("restored operator connection");
          client = await fixture.connect(({ event, payload }) => {
            if (event === "question.resolved" && isRecord(payload) && payload.id === question.id) {
              resolutionEvents += 1;
              if (resolutionEvents === 2) {
                terminalReceiptPublished.resolve();
              }
            }
          });
          const restoredClient = client;
          setStage("restored pending custody read");
          expect(
            (await client.request<QuestionGetResult>("question.get", { id: question.id })).question,
          ).toEqual(question);
          if (queued) {
            setStage("unrelated foreground admission and provider hold");
            await client.request(
              "chat.send",
              {
                sessionKey: question.sessionKey,
                message: "DURABLE_BUSY_PROOF: hold the unrelated foreground turn.",
                idempotencyKey: "channel-queue-blocker",
                deliver: false,
              },
              { expectFinal: false },
            );
            await withinTest(Promise.race([fixture.busyStarted, fixture.failed]), signal);
          }
          setStage("answer settlement");
          await client.request("question.resolve", {
            id: question.id,
            answers: { answers: { choice: ["Staging"] } },
            resolutionId: "channel-answer",
          });
          const effectPath = path.join(
            fixture.instance.state.workspaceDir,
            "durable-question-continuation-effect",
          );
          let queuedRunId: string | undefined;
          if (queued) {
            setStage("exact claimed continuation held behind foreground turn");
            await vi.waitFor(
              async () => {
                const held = await restoredClient.request<QuestionGetResult>("question.get", {
                  id: question.id,
                  includeContinuation: true,
                });
                expect(held.continuation).toMatchObject({ status: "claimed" });
                queuedRunId = held.continuation?.runId;
                expect(queuedRunId).toEqual(expect.any(String));
              },
              { timeout: 30_000 },
            );
            expect(fixture.continuationCount).toBe(0);
            expect(deliveries).not.toContain("DURABLE_CONTINUATION_USED_STAGING");
            await expect(access(effectPath)).rejects.toMatchObject({ code: "ENOENT" });
            if (refused) {
              setStage("running Gateway canonical sender authority revocation");
              expect(
                await client.request("users.unlinkChannelIdentity", {
                  profileId,
                  identity: {
                    channelId: "telegram",
                    accountId: "team",
                    senderId: telegram.senderId,
                  },
                }),
              ).toEqual({ removed: true });
              if (authority === "queued-reassign") {
                await client.request("users.linkChannelIdentity", {
                  profileId: successorProfileId,
                  identity: {
                    channelId: "telegram",
                    accountId: "team",
                    senderId: telegram.senderId,
                  },
                });
              }
            }
            process.stderr.write(
              `[durable-question:authority-proof] ${JSON.stringify({ scenario: authority, phase: "claimed-before-release", providerRequests: fixture.continuationCount, finalDeliveries: 0, toolMarkerPresent: false })}\n`,
            );
            fixture.releaseBusy();
          }
          setStage("continuation terminal receipt and delivery");
          if (refused) {
            await vi.waitFor(
              async () => {
                const blocked = await restoredClient.request<QuestionGetResult>("question.get", {
                  id: question.id,
                  includeContinuation: true,
                });
                expect(blocked.continuation).toMatchObject({
                  status: queued ? "interrupted" : "blocked",
                });
                expect(blocked.continuation?.reason).toContain("new user turn");
                expect(blocked.question.answers).toEqual({ answers: { choice: ["Staging"] } });
              },
              { timeout: 30_000 },
            );
            await withinTest(terminalReceiptPublished.promise, signal);
            expect(deliveries).not.toContain("DURABLE_CONTINUATION_USED_STAGING");
            expect(fixture.continuationCount).toBe(0);
            if (queued) {
              if (!queuedRunId) {
                throw new Error("Queued continuation must retain its exact native run ID");
              }
              expect(
                await client.request("agent.wait", { runId: queuedRunId, timeoutMs: 30_000 }),
              ).toMatchObject({ status: "error" });
              await expect(access(effectPath)).rejects.toMatchObject({ code: "ENOENT" });
              process.stderr.write(
                `[durable-question:authority-proof] ${JSON.stringify({ scenario: authority, phase: "terminal-after-release", receipt: "interrupted", providerRequests: 0, finalDeliveries: 0, toolMarkerPresent: false })}\n`,
              );
            }
            return;
          }
          await withinTest(Promise.race([fixture.continued, fixture.failed]), signal);
          await vi.waitFor(
            () => expect(deliveries).toContain("DURABLE_CONTINUATION_USED_STAGING"),
            {
              timeout: 30_000,
            },
          );
          await vi.waitFor(
            async () => {
              const receipt = await restoredClient.request<QuestionGetResult>("question.get", {
                id: question.id,
                includeContinuation: true,
              });
              expect(receipt.continuation).toMatchObject({ status: "settled" });
            },
            { timeout: 30_000 },
          );
          if (queued) {
            expect((await readFile(effectPath, "utf8")).trim()).toBe("completed");
            expect(fixture.continuationCount).toBe(2);
            expect(
              deliveries.filter((text) => text === "DURABLE_CONTINUATION_USED_STAGING"),
            ).toHaveLength(1);
            process.stderr.write(
              `[durable-question:authority-proof] ${JSON.stringify({ scenario: authority, phase: "terminal-after-release", receipt: "settled", providerRequests: fixture.continuationCount, finalDeliveries: 1, toolMarkerPresent: true })}\n`,
            );
          }
          expect(recipients[deliveries.indexOf("DURABLE_CONTINUATION_USED_STAGING")]).toBe(
            recipients[deliveries.findIndex((text) => text.includes("Which environment?"))],
          );
        } catch (error) {
          throw new Error(report(), { cause: error });
        }
      },
      () => {
        setStage("operator client cleanup");
        return client?.stopAndWait();
      },
      () => {
        setStage("Gateway fixture cleanup");
        return fixture.cleanup();
      },
      () => telegram.close(),
      () => signal.removeEventListener("abort", onAbort),
    );
  },
);
