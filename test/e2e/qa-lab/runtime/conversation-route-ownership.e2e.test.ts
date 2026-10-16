import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClientRequestError } from "@openclaw/gateway-client";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  startQaBusServer,
} from "../../../../extensions/qa-lab/api.js";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const CHANNEL_ID = "qa-channel";
const primary = { agentId: "main", accountId: "default", peerId: "primary-peer" };
const sibling = { agentId: "finance", accountId: "finance", peerId: "finance-peer" };
type Owner = typeof primary;

type GatewayHarness = Awaited<ReturnType<ReturnType<typeof createQaLiveLaneGateway>["start"]>>;

let gatewayOwner: ReturnType<typeof createQaLiveLaneGateway> | undefined;
let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;

async function listConversations(gateway: GatewayHarness["gateway"], agentId: string) {
  const payload = await gateway.call("conversations.list", {
    agentId,
    channel: CHANNEL_ID,
    limit: 50,
  });
  if (!isRecord(payload) || !Array.isArray(payload.conversations)) {
    throw new Error(`conversations.list returned an invalid payload: ${JSON.stringify(payload)}`);
  }
  const items = payload.conversations.filter(isRecord);
  if (items.length !== payload.conversations.length) {
    throw new Error(`conversations.list returned an invalid item: ${JSON.stringify(payload)}`);
  }
  return items;
}

function findConversation(items: Array<Record<string, unknown>>, { accountId, peerId }: Owner) {
  return items.find(
    ({ accountId: id, target }) =>
      id === accountId && typeof target === "string" && target.includes(peerId),
  );
}

async function waitForConversation(gateway: GatewayHarness["gateway"], owner: Owner) {
  const deadline = Date.now() + 30_000;
  let latest: Array<Record<string, unknown>> = [];
  while (Date.now() < deadline) {
    try {
      latest = await listConversations(gateway, owner.agentId);
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      if (
        !(cause instanceof GatewayClientRequestError) ||
        cause.code !== "UNAVAILABLE" ||
        cause.message !== "Conversation binding ownership changed. Retry the request."
      ) {
        throw error;
      }
      // Seed binding publications can invalidate this read while ownership is converging.
      latest = [];
    }
    const match = findConversation(latest, owner);
    if (match) {
      return match;
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(owner)}: ${JSON.stringify(latest)}`);
}

async function waitForAppliedConfig(gateway: GatewayHarness["gateway"], hash: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const payload = await gateway.call("config.get", {});
    if (
      isRecord(payload) &&
      payload.hash === hash &&
      payload.appliedConfigHash === payload.configRevisionHash
    ) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Gateway did not apply config revision ${hash}`);
}

function outboundCount(
  state: ReturnType<typeof createQaBusState>,
  accountId: string,
  text: string,
) {
  return state
    .getSnapshot()
    .messages.filter(
      ({ direction, accountId: id, text: value }) =>
        direction === "outbound" && id === accountId && value === text,
    ).length;
}

function route({ agentId, accountId }: Pick<Owner, "agentId" | "accountId">) {
  return { type: "route" as const, agentId, match: { channel: CHANNEL_ID, accountId } };
}

afterEach(async () => {
  const cleanupErrors: unknown[] = [];
  try {
    if (gatewayOwner) {
      await stopQaGatewayFixture(gatewayOwner);
    }
  } catch (error) {
    cleanupErrors.push(error);
  } finally {
    gatewayOwner = undefined;
  }
  try {
    await bus?.stop();
  } catch (error) {
    cleanupErrors.push(error);
  } finally {
    bus = undefined;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "conversation route ownership proof cleanup failed");
  }
});

describe("conversation route ownership clean-machine proof", () => {
  it(
    "keeps sibling accounts isolated and revalidates persisted references after reassignment",
    { timeout: 120_000 },
    async () => {
      const state = createQaBusState();
      bus = await startQaBusServer({ state });
      gatewayOwner = createQaLiveLaneGateway();
      const { gateway } = await gatewayOwner.start({
        repoRoot: process.cwd(),
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        transport: createQaChannelTransport(state),
        transportBaseUrl: bus.baseUrl,
        controlUiEnabled: false,
        mockAuthAgentIds: [primary.agentId, sibling.agentId],
        mutateConfig: (config) => {
          config.agents = {
            ...config.agents,
            ownership: "explicit",
            entries: {
              ...config.agents?.entries,
              [primary.agentId]: {},
              [sibling.agentId]: {},
            },
          };
          config.bindings = [route(primary), route(sibling)];
          const account = {
            baseUrl: bus?.baseUrl,
            enabled: true,
            allowFrom: ["*"],
            pollTimeoutMs: 250,
          };
          config.channels ??= {};
          config.channels[CHANNEL_ID] = {
            ...config.channels[CHANNEL_ID],
            accounts: { [sibling.accountId]: account },
          };
          return config;
        },
      });
      const send = (agentId: string, conversationRef: string, message: string) =>
        gateway.call("conversations.send", {
          agentId,
          operationId: randomUUID(),
          conversationRef,
          message,
        });

      const seed = ({ accountId, peerId }: Owner, text: string) =>
        state.addInboundMessage({
          accountId,
          conversation: { kind: "direct", id: peerId },
          senderId: peerId,
          text,
        });
      seed(primary, "seed primary ownership");
      seed(sibling, "seed sibling ownership");
      const primaryConversation = await waitForConversation(gateway, primary);
      const siblingConversation = await waitForConversation(gateway, sibling);
      const primaryList = await listConversations(gateway, primary.agentId);
      const siblingList = await listConversations(gateway, sibling.agentId);

      const primaryConversationRef = String(primaryConversation.conversationRef);
      const siblingConversationRef = String(siblingConversation.conversationRef);
      const initialAllowedText = `ownership-proof-initial-${randomUUID()}`;
      await send(primary.agentId, primaryConversationRef, initialAllowedText);

      const configBefore = await gateway.call("config.get", {});
      if (!isRecord(configBefore) || typeof configBefore.hash !== "string") {
        throw new Error(`config.get returned no hash: ${JSON.stringify(configBefore)}`);
      }
      const patchResult = await gateway.call("config.patch", {
        raw: JSON.stringify({
          bindings: [
            route({ agentId: sibling.agentId, accountId: primary.accountId }),
            route(sibling),
          ],
        }),
        baseHash: configBefore.hash,
        replacePaths: ["bindings"],
        restartDelayMs: 0,
      });
      if (!isRecord(patchResult) || typeof patchResult.hash !== "string") {
        throw new Error(`config.patch returned no hash: ${JSON.stringify(patchResult)}`);
      }
      await waitForAppliedConfig(gateway, patchResult.hash);

      const staleSendText = `ownership-proof-stale-send-${randomUUID()}`;
      const denied = (request: Promise<unknown>) =>
        request.then(
          () => false,
          () => true,
        );
      const staleSendDenied = await denied(
        send(primary.agentId, primaryConversationRef, staleSendText),
      );

      const staleTurnText = `ownership-proof-stale-turn-${randomUUID()}`;
      const staleTurnDenied = await denied(
        gateway.call("conversations.turn", {
          agentId: primary.agentId,
          turnId: randomUUID(),
          conversationRef: primaryConversationRef,
          message: staleTurnText,
          timeoutMs: 1_000,
        }),
      );

      const siblingAllowedText = `ownership-proof-sibling-${randomUUID()}`;
      await send(sibling.agentId, siblingConversationRef, siblingAllowedText);

      const verdict = {
        ok: true,
        siblingAccountHiddenFromPrimaryAgent: findConversation(primaryList, sibling) === undefined,
        primaryAccountHiddenFromSiblingAgent: findConversation(siblingList, primary) === undefined,
        initialOwnerDeliveredExactlyOnce:
          outboundCount(state, primary.accountId, initialAllowedText) === 1,
        staleSendDeniedWithoutProviderIo:
          staleSendDenied && outboundCount(state, primary.accountId, staleSendText) === 0,
        staleTurnDeniedWithoutProviderIo:
          staleTurnDenied && outboundCount(state, primary.accountId, staleTurnText) === 0,
        siblingOwnerDeliveredExactlyOnce:
          outboundCount(state, sibling.accountId, siblingAllowedText) === 1,
      };
      expect(verdict).toEqual({
        ok: true,
        siblingAccountHiddenFromPrimaryAgent: true,
        primaryAccountHiddenFromSiblingAgent: true,
        initialOwnerDeliveredExactlyOnce: true,
        staleSendDeniedWithoutProviderIo: true,
        staleTurnDeniedWithoutProviderIo: true,
        siblingOwnerDeliveredExactlyOnce: true,
      });
      console.log(`CONVERSATION_ROUTE_OWNERSHIP_PROOF=${JSON.stringify(verdict)}`);
    },
  );
});
