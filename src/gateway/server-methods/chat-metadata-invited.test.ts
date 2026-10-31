import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { handleChatMetadataRequest } from "./chat-metadata-handler.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

async function withInvitedMetadata(
  run: (fixture: Awaited<ReturnType<typeof metadataFixture>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const fixture = await metadataFixture();
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    await run(fixture);
  });
}

async function metadataFixture() {
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            agents: "*",
            scopes: ["operator.sessions.read"],
            // @ts-expect-error Runtime invitation policy precedes config enum activation in step 13.
            sessions: { others: "invited" },
          },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(cfg);
  const owner = ensureProfileForEmail("metadata-owner@invited.test");
  const member = ensureProfileForEmail("metadata-member@invited.test");
  const outsider = ensureProfileForEmail("metadata-outsider@invited.test");
  const clientFor = (profileId: string) => {
    const client = sharingPolicyClient({ user: profileId, scopes: ["operator.sessions.read"] });
    prepareGatewayRecipientProfile(client);
    return client;
  };
  const client = clientFor(member.id);
  const nonmember = clientFor(outsider.id);
  const scope = { agentId: "main", sessionKey: "agent:main:invited-metadata" };
  await upsertSessionEntryCore(scope, {
    sessionId: "invited-metadata",
    updatedAt: 1,
    visibility: "shared",
    createdActor: { type: "human", source: "profile", id: owner.id },
  });
  await addSessionMember(scope, { identityId: member.id, addedBy: owner.id });
  const metadata = { commands: [{ name: "synthetic-command" }], swarmEnabled: false };
  const readChatMetadata = vi.fn<GatewayRequestContext["readChatMetadata"]>(async () => metadata);
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg, readChatMetadata });
  return {
    context,
    client,
    nonmember,
    metadata,
    readChatMetadata,
    async revoke() {
      expect(await removeSessionMember(scope, member.id)).not.toBeNull();
    },
    dispatch(viewer = client, signal?: AbortSignal) {
      const respond = vi.fn<RespondFn>();
      const pending = handleChatMetadataRequest({
        req: { type: "req", id: "invited-metadata", method: "chat.metadata" },
        params: { sessionKey: scope.sessionKey },
        client: viewer,
        context,
        respond,
        signal,
        isWebchatConnect: () => false,
      });
      return { pending, respond };
    },
  };
}

function expectHidden(respond: ReturnType<typeof vi.fn<RespondFn>>) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    false,
    undefined,
    expect.objectContaining({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("not found"),
    }),
  );
}

it("chat.metadata serves an invited member but never prepares metadata for a nonmember", () =>
  withInvitedMetadata(async (fixture) => {
    const member = fixture.dispatch();
    await member.pending;
    expect(member.respond).toHaveBeenCalledExactlyOnceWith(true, fixture.metadata);
    fixture.readChatMetadata.mockClear();
    const outsider = fixture.dispatch(fixture.nonmember);
    await outsider.pending;
    expectHidden(outsider.respond);
    expect(fixture.readChatMetadata).not.toHaveBeenCalled();
  }));

it("chat.metadata rechecks membership after asynchronous placement preparation", async ({
  signal,
}) =>
  withInvitedMetadata(async (fixture) => {
    const placement = createWorkerSessionPlacementStore();
    fixture.context.workerSessionPlacementService = placement;
    const entered = createDeferred();
    const release = createDeferred();
    const getMany = placement.getManyAsync.bind(placement);
    vi.spyOn(placement, "getManyAsync").mockImplementationOnce(async (ids) => {
      const result = await getMany(ids);
      entered.resolve();
      await release.promise;
      return result;
    });
    const request = fixture.dispatch(fixture.client, signal);
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          request.pending,
          "metadata did not reach placement preparation",
        ),
        signal,
      );
      await fixture.revoke();
    } finally {
      release.resolve();
      await request.pending;
    }
    expectHidden(request.respond);
    expect(fixture.readChatMetadata).not.toHaveBeenCalled();
  }));

it.for(["publication", "provider dispatch"] as const)(
  "chat.metadata rechecks membership before %s after preparation yields",
  async (boundary, { signal }) =>
    withInvitedMetadata(async (fixture) => {
      const entered = createDeferred();
      const release = createDeferred();
      const inferenceIo = vi.fn();
      // The metadata service is the handler dependency; its I/O fixture consumes the
      // real handler-owned synchronous dispatch guard, never a mocked auth result.
      fixture.readChatMetadata.mockImplementationOnce(async (scope) => {
        entered.resolve();
        await release.promise;
        if (boundary === "provider dispatch") {
          expectDefined(scope.beforeRequest, "saved-session dispatch authority")();
          inferenceIo();
        }
        return fixture.metadata;
      });
      const request = fixture.dispatch(fixture.client, signal);
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            request.pending,
            "metadata service was not entered",
          ),
          signal,
        );
        await fixture.revoke();
      } finally {
        release.resolve();
        await request.pending;
      }
      expectHidden(request.respond);
      if (boundary === "provider dispatch") {
        expect(inferenceIo).not.toHaveBeenCalled();
      }
    }),
);
