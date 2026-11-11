import { expect, it } from "vitest";
import {
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import { resolveCronResultConversation } from "../session-target.js";
import {
  readConversationMessages,
  withCompletionFixture,
} from "./current-session-completion.test-fixtures.js";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import { resolveCronDeliveryContext } from "./run-delivery-trace.js";

type Fixture = Parameters<Parameters<typeof withCompletionFixture>[0]>[0];

// Compose the same production steps as run preparation and finalization: resolve the
// delivery context, pick the result conversation, then dispatch with real persistence.
async function selectInbox(fixture: Fixture, bound = true) {
  const inbox = { ...fixture.scope, sessionKey: "agent:main:dashboard:inbox" };
  const generation = { sessionId: "inbox-session", lifecycleRevision: "inbox-generation" };
  await replaceSessionEntry(inbox, { ...generation, updatedAt: 1 });
  fixture.job.delivery = { mode: "announce", sessionKey: inbox.sessionKey };
  if (bound) {
    fixture.job.deliveryConversation = { sessionKey: inbox.sessionKey, ...generation };
  }
  const context = await resolveCronDeliveryContext({
    cfg: fixture.params.cfgWithAgentDefaults,
    job: fixture.job,
    agentId: "main",
  });
  Object.assign(
    fixture.params,
    {
      deliveryPlan: context.deliveryPlan,
      deliveryRequested: context.deliveryRequested,
      resolvedDelivery: context.resolvedDelivery,
      deliveryPayloads: [{ text: "Inbox report" }],
    },
    resolveCronResultConversation(fixture.job, fixture.params),
  );
  return inbox;
}

async function assistantMessages(scope: Parameters<typeof readConversationMessages>[0]) {
  return (await readConversationMessages(scope)).map(readTranscriptEventMessage);
}

it.each(["isolated", "current"] as const)(
  "commits a %s run result only to the selected conversation",
  (sessionTarget) =>
    withCompletionFixture(async (fixture) => {
      const inbox = await selectInbox(fixture);

      await expect(dispatchCronDelivery(fixture.params)).resolves.toMatchObject({
        delivered: true,
        deliveryError: undefined,
      });
      expect(await assistantMessages(inbox)).toEqual([
        expect.objectContaining({
          content: [{ type: "text", text: "Inbox report" }],
          openclawAutomation: {
            kind: "cron",
            jobId: fixture.job.id,
            runId: "cron:report-job:1000",
          },
        }),
      ]);
      // The creating conversation keeps its execution role but receives no result.
      expect(await assistantMessages(fixture.scope)).toEqual([]);
    }, sessionTarget),
);

it("keeps the selected conversation over a configured default destination", () =>
  withCompletionFixture(async (fixture) => {
    fixture.params.cfgWithAgentDefaults = {
      ...fixture.params.cfgWithAgentDefaults,
      cron: { delivery: { channel: "telegram", to: "123" } },
    };
    const inbox = await selectInbox(fixture);

    await expect(dispatchCronDelivery(fixture.params)).resolves.toMatchObject({
      delivered: true,
      deliveryError: undefined,
    });
    expect((await assistantMessages(inbox)).map((message) => message?.content)).toEqual([
      [{ type: "text", text: "Inbox report" }],
    ]);
  }, "isolated"));

it("fails delivery to a reset selected conversation without falling back", () =>
  withCompletionFixture(async (fixture) => {
    const inbox = await selectInbox(fixture);
    await resetSessionEntryLifecycle({
      storePath: inbox.storePath,
      target: { canonicalKey: inbox.sessionKey, storeKeys: [inbox.sessionKey] },
      buildNextEntry: () => ({
        sessionId: "inbox-replacement",
        lifecycleRevision: "inbox-replacement-generation",
        updatedAt: 2,
      }),
    });

    await expect(dispatchCronDelivery(fixture.params)).resolves.toMatchObject({
      delivered: false,
      deliveryError: expect.stringContaining("session rebound"),
      disposition: { kind: "error", errorKind: "delivery-target" },
    });
    expect(await assistantMessages(inbox)).toEqual([]);
    expect(await assistantMessages(fixture.scope)).toEqual([]);
  }, "isolated"));

it("fails delivery when the selected conversation was never captured", () =>
  withCompletionFixture(async (fixture) => {
    const inbox = await selectInbox(fixture, false);

    await expect(dispatchCronDelivery(fixture.params)).resolves.toMatchObject({
      delivered: false,
      deliveryError: expect.stringContaining("has no captured conversation"),
    });
    expect(await assistantMessages(inbox)).toEqual([]);
    expect(await assistantMessages(fixture.scope)).toEqual([]);
  }, "isolated"));
