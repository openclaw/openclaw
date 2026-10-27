import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { SessionHistoryWorkerRequest } from "../../config/sessions/session-history-types.js";
import * as historyWorker from "../../config/sessions/session-history-worker-runtime.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { progressCardStore } from "../progress-card-store.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import * as transcriptPreview from "../session-transcript-preview.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import * as historyPages from "./chat-history-pages.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { progressCardHandlers } from "./progress-card.js";
import { sessionReadHandlers } from "./sessions-read.js";
import type { RespondFn } from "./types.js";

type Method = "chat.history" | "sessions.get" | "sessions.preview" | "sessions.describe";
const methods = ["chat.history", "sessions.get", "sessions.preview", "sessions.describe"] as const;
const sessionKey = "agent:main:invited-read";
const sessionId = "invited-read";
const content = "Synthetic member-only history";

afterEach(() => vi.restoreAllMocks());

async function withInvitedRead(
  run: (fixture: Awaited<ReturnType<typeof readFixture>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const fixture = await readFixture();
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    await run(fixture);
  });
}

async function readFixture() {
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            agents: "*",
            scopes: ["operator.sessions.read"],
            sessions: { others: "invited" },
          },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(cfg);
  const owner = ensureProfileForEmail("read-owner@invited.test");
  const member = ensureProfileForEmail("read-member@invited.test");
  const outsider = ensureProfileForEmail("read-outsider@invited.test");
  const clientFor = (profileId: string) => {
    const client = sharingPolicyClient({ user: profileId, scopes: ["operator.sessions.read"] });
    prepareGatewayRecipientProfile(client);
    return client;
  };
  const client = clientFor(member.id);
  const nonmember = clientFor(outsider.id);
  const scope = { agentId: "main", sessionKey, sessionId };
  await upsertSessionEntryCore(scope, {
    sessionId,
    updatedAt: 1,
    visibility: "shared",
    createdActor: { type: "human", source: "profile", id: owner.id },
  });
  await appendTranscriptMessage(scope, { message: { role: "user", content, timestamp: 1 } });
  await addSessionMember(scope, { identityId: member.id, addedBy: owner.id });
  const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
  return {
    context,
    client,
    nonmember,
    async revoke() {
      expect(await removeSessionMember(scope, member.id)).not.toBeNull();
    },
    dispatch(method: Method, viewer = client, signal?: AbortSignal) {
      const respond = vi.fn<RespondFn>();
      const handler =
        method === "chat.history" ? chatHistoryHandlers[method] : sessionReadHandlers[method];
      const params =
        method === "chat.history"
          ? { sessionKey }
          : method === "sessions.preview"
            ? { keys: [sessionKey] }
            : { key: sessionKey };
      const pending = expectDefined(
        handler,
        "session read handler",
      )({
        req: { type: "req", id: "invited-read", method },
        params,
        client: viewer,
        context,
        respond,
        signal,
        isWebchatConnect: () => false,
      });
      return { pending: Promise.resolve(pending), respond };
    },
  };
}

function expectVisible(method: Method, respond: ReturnType<typeof vi.fn<RespondFn>>) {
  expect(respond).toHaveBeenCalledOnce();
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  expect(respond.mock.calls[0]?.[1]).toMatchObject(
    method === "sessions.describe"
      ? { session: { key: sessionKey, sessionId, sharingRole: "member" } }
      : method === "sessions.preview"
        ? {
            previews: [{ key: sessionKey, status: "ok", items: [{ role: "user", text: content }] }],
          }
        : { messages: [expect.objectContaining({ role: "user", content })] },
  );
}

function expectHidden(method: Method, respond: ReturnType<typeof vi.fn<RespondFn>>) {
  expect(respond).toHaveBeenCalledOnce();
  if (method === "chat.history") {
    expect(respond.mock.calls[0]).toEqual([
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("not found"),
      }),
    ]);
    return;
  }
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  expect(respond.mock.calls[0]?.[1]).toMatchObject(
    method === "sessions.describe"
      ? { session: null }
      : method === "sessions.preview"
        ? { previews: [{ key: sessionKey, status: "missing", items: [] }] }
        : { messages: [] },
  );
  expect(JSON.stringify(respond.mock.calls)).not.toContain(content);
}

it.for(methods)("%s exposes member content and hides the same session from nonmembers", (method) =>
  withInvitedRead(async (fixture) => {
    const member = fixture.dispatch(method);
    await member.pending;
    expectVisible(method, member.respond);
    const outsider = fixture.dispatch(method, fixture.nonmember);
    await outsider.pending;
    expectHidden(method, outsider.respond);
  }),
);

it.for(["chat.history", "sessions.get", "sessions.preview"] as const)(
  "%s rechecks membership after its asynchronous read preparation",
  async (method, { signal }) =>
    withInvitedRead(async (fixture) => {
      const entered = createDeferred();
      const release = createDeferred();
      const pause = async <T>(value: Promise<T>): Promise<T> => {
        const result = await value;
        entered.resolve();
        await release.promise;
        return result;
      };
      // Preserve the real read and its data; only hold its completed result before
      // the handler consumes/publishes it, while the real membership writer commits.
      if (method === "chat.history") {
        const read = historyPages.readChatHistoryPage;
        vi.spyOn(historyPages, "readChatHistoryPage").mockImplementationOnce((...args) =>
          pause(read(...args)),
        );
      } else if (method === "sessions.get") {
        const read = historyWorker.readSessionHistoryPageInWorker;
        vi.spyOn(historyWorker, "readSessionHistoryPageInWorker").mockImplementationOnce(
          <Request extends SessionHistoryWorkerRequest>(
            request: Request,
            requestSignal?: AbortSignal,
          ) => pause(read(request, requestSignal)),
        );
      } else if (method === "sessions.preview") {
        const read = transcriptPreview.readSessionPreviewItemsFromTranscriptAsync;
        vi.spyOn(
          transcriptPreview,
          "readSessionPreviewItemsFromTranscriptAsync",
        ).mockImplementationOnce((...args) => pause(read(...args)));
      }
      const request = fixture.dispatch(method, fixture.client, signal);
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            request.pending,
            "read completed before reaching its preparation gate",
          ),
          signal,
        );
        expect(request.respond).not.toHaveBeenCalled();
        await fixture.revoke();
      } finally {
        release.resolve();
        await request.pending;
      }
      expectHidden(method, request.respond);
    }),
);

it("progressCard.get retains invited access and rechecks it before publishing a prepared card", async ({
  signal,
}) =>
  withInvitedRead(async (fixture) => {
    await progressCardStore.put(sessionKey, { markdown: "Synthetic member-only plan" }, "main");
    const dispatch = (viewer = fixture.client) => {
      const respond = vi.fn<RespondFn>();
      const pending = Promise.resolve(
        expectDefined(
          progressCardHandlers["progressCard.get"],
          "progress card handler",
        )({
          req: { type: "req", id: "invited-card", method: "progressCard.get" },
          params: { sessionKey, agentId: "main" },
          client: viewer,
          context: fixture.context,
          respond,
          signal,
          isWebchatConnect: () => false,
        }),
      );
      return { pending, respond };
    };
    const member = dispatch();
    await member.pending;
    expect(member.respond).toHaveBeenCalledWith(
      true,
      { card: expect.objectContaining({ markdown: "Synthetic member-only plan" }) },
      undefined,
    );
    const hidden = {
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("not found") },
    };
    const outsider = dispatch(fixture.nonmember);
    await expect(outsider.pending).rejects.toMatchObject(hidden);
    expect(outsider.respond).not.toHaveBeenCalled();

    const entered = createDeferred();
    const release = createDeferred();
    const get = progressCardStore.get.bind(progressCardStore);
    vi.spyOn(progressCardStore, "get").mockImplementationOnce(async (...args) => {
      const card = await get(...args);
      entered.resolve();
      await release.promise;
      return card;
    });
    const request = dispatch();
    const rejected = expect(request.pending).rejects.toMatchObject(hidden);
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          request.pending,
          "card read did not reach publication gate",
        ),
        signal,
      );
      await fixture.revoke();
    } finally {
      release.resolve();
      await rejected;
    }
    expect(request.respond).not.toHaveBeenCalled();
  }));
