import { existsSync, renameSync, unlinkSync } from "node:fs";
import { backup } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  registerNative,
  useNativeProcessFixture,
} from "../../agents/harness/acp-native-process.test-support.js";
import * as replyInitialization from "../../config/sessions/session-accessor.reset.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listSessionEntries, upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { GatewayClient, RespondFn } from "./types.js";

vi.mock("./chat-send-admission.js", () => ({
  admitChatSend: () => {
    throw new Error("Refused native input must not enter send admission");
  },
}));
useNativeProcessFixture();

type TestState = Parameters<Parameters<typeof withOpenClawTestState>[1]>[0];
async function withNative(run: (state: TestState, config: OpenClawConfig) => Promise<void>) {
  await withOpenClawTestState({ label: "chat-native-consent" }, async (state) => {
    const config = nativeConfig(state.workspaceDir);
    await state.writeConfig(config);
    const native = await registerNative(state, config, "owner-agent.mjs");
    try {
      await run(state, config);
    } finally {
      await native.service.stop?.(native.context);
    }
  });
}

function nativeConfig(workspace: string): OpenClawConfig {
  return {
    tools: { profile: "full", deny: ["browser"] },
    agents: {
      defaults: {
        workspace,
        model: { primary: "acp-opencode/selected" },
        models: { "acp-opencode/selected": { agentRuntime: { id: "acp-opencode" } } },
      },
    },
  };
}

function nativeClient(scopes = ["operator.admin"], profileId?: string): GatewayClient {
  return {
    connId: "native-consent-client",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
    },
    authenticatedUserProfile: profileId
      ? { profileId, displayName: null, hasAvatar: false, updatedAt: 1 }
      : undefined,
  };
}

function sendNative(
  config: OpenClawConfig,
  client = nativeClient(),
  sessionKey = "agent:main:main",
  isWebchat = true,
) {
  const respond = vi.fn<RespondFn>();
  const context = createDirectChatContext({ getRuntimeConfig: () => config });
  const send = () =>
    expectDefined(
      coreGatewayHandlers["chat.send"],
      "registered chat.send",
    )({
      req: { type: "req", id: "native-consent-request", method: "chat.send" },
      params: {
        sessionKey,
        agentId: "main",
        message: "Keep this input unsent until I choose native permissions.",
        idempotencyKey: "native-consent-run",
      },
      respond,
      context,
      client,
      isWebchatConnect: () => isWebchat,
    });
  return { respond, context, send };
}

function pauseConsentCommit() {
  const entered = createDeferred();
  const release = createDeferred();
  const commit = replyInitialization.commitReplySessionInitialization;
  vi.spyOn(replyInitialization, "commitReplySessionInitialization").mockImplementation(
    async (params) => {
      entered.resolve();
      await release.promise;
      return commit(params);
    },
  );
  return { entered, release };
}

function restricted(respond: ReturnType<typeof vi.fn<RespondFn>>, reason: string) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      details: expect.objectContaining({ code: "AGENT_RUNTIME_RESTRICTED", reason }),
    }),
  );
}

function captureOutcome(send: () => unknown) {
  return Promise.resolve(send()).then(
    () => undefined,
    (error: unknown) => error,
  );
}

it.each([false, true])(
  "refuses native chat.send before input persistence with an existing session=%s",
  (preseed) =>
    withNative(async (_state, config) => {
      const target = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:native-consent",
        sessionId: "native-consent-session",
      };
      if (preseed) {
        await upsertSessionEntry({
          ...target,
          entry: {
            sessionId: target.sessionId,
            updatedAt: Date.now(),
            providerOverride: "acp-opencode",
            modelOverride: "selected",
            modelOverrideSource: "user",
            agentRuntimeOverride: "acp-opencode",
            permissionMode: "full",
            sandboxMode: "off",
          },
        });
      }
      const { respond, context, send } = sendNative(
        config,
        nativeClient(),
        target.sessionKey,
        false,
      );
      await send();
      restricted(respond, "tool-policy");
      const persisted = expectDefined(
        listSessionEntries({ agentId: target.agentId, readOnly: true }).find(
          (row) => row.sessionKey === target.sessionKey,
        )?.entry,
        "real consent-bound session",
      );
      expect(respond.mock.calls[0]?.[2]?.details).toMatchObject({
        recovery: { sessionId: persisted.sessionId },
        runtimeId: "acp-opencode",
      });
      expect(
        await readVisibleSessionTranscriptMessageEntries({
          ...target,
          sessionId: persisted.sessionId,
        }),
      ).toEqual([]);
      expect(persisted.nativeRuntimeConsent).toBeUndefined();
      if (!preseed) {
        expect(persisted.lifecycleRevision).toBeTypeOf("string");
        expect([
          persisted.providerOverride,
          persisted.modelOverride,
          persisted.agentRuntimeOverride,
        ]).toEqual([undefined, undefined, undefined]);
      }
      expect(context.chatAbortControllers.size).toBe(0);
    }),
);

it.each([
  { kind: "non-admin", reason: "tool-policy" },
  { kind: "creator sandbox", reason: "sandbox-required" },
  { kind: "execution sandbox", reason: "sandbox-required" },
  { kind: "remote execution", reason: "remote-execution" },
] as const)("refuses a new $kind target without creating a consent row", ({ kind, reason }) =>
  withOpenClawTestState({ label: "chat-native-mandatory" }, async (state) => {
    const config = nativeConfig(state.workspaceDir);
    const profile = ensureProfileForEmail("native-creator@example.test");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const client = nativeClient(kind === "non-admin" ? ["operator.write"] : undefined, profile.id);
    if (kind === "creator sandbox") {
      config.gateway = {
        roles: {
          default: "restricted",
          definitions: {
            restricted: {
              agents: "*",
              scopes: ["operator.admin"],
              sessions: { others: "write" },
              sandbox: "required",
            },
          },
        },
      };
    } else if (kind === "execution sandbox" || kind === "remote execution") {
      config.tools = {
        ...config.tools,
        exec: { host: kind === "execution sandbox" ? "sandbox" : "node" },
      };
    }
    await state.writeConfig(config);
    const native = await registerNative(state, config, "owner-agent.mjs");
    const { respond, context, send } = sendNative(config, client);
    try {
      await send();
      restricted(respond, reason);
      expect(respond.mock.calls[0]?.[2]?.details).not.toHaveProperty("recovery");
      expect(listSessionEntries({ agentId: "main", readOnly: true })).toEqual([]);
      expect(context.chatAbortControllers.size).toBe(0);
    } finally {
      await native.service.stop?.(native.context);
    }
  }),
);

it.each(["authority", "mandatory policy", "competing entry"] as const)(
  "rechecks $change before committing first-send consent identity",
  (change) =>
    withNative(async (_state, config) => {
      const client = nativeClient();
      const { context, send } = sendNative(config, client);
      const sessionKey = "agent:main:main";
      const { entered, release } = pauseConsentCommit();
      const outcome = captureOutcome(send);
      try {
        await entered.promise;
        if (change === "authority") {
          client.connect.scopes = ["operator.write"];
        } else if (change === "mandatory policy") {
          config.tools = { ...config.tools, exec: { host: "sandbox" } };
        } else {
          await upsertSessionEntry({
            agentId: "main",
            sessionKey,
            entry: { sessionId: "competing-session", updatedAt: 1, label: "Keep competing entry" },
          });
        }
        release.resolve();
        await outcome;
        const entries = listSessionEntries({ agentId: "main", readOnly: true });
        if (change === "competing entry") {
          expect(entries).toMatchObject([
            {
              sessionKey,
              entry: { sessionId: "competing-session", label: "Keep competing entry" },
            },
          ]);
        } else {
          expect(entries).toEqual([]);
        }
        expect(entries.every(({ entry }) => entry.nativeRuntimeConsent === undefined)).toBe(true);
        expect(context.chatAbortControllers.size).toBe(0);
      } finally {
        release.resolve();
        await outcome;
      }
    }),
);

it.runIf(process.platform !== "win32")(
  "rejects first-send consent when its captured database owner is replaced",
  () =>
    withNative(async (state, config) => {
      const { respond, context, send } = sendNative(config);
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
      const replacementPath = `${databasePath}.native-replacement`;
      const displacedPath = `${databasePath}.native-original`;
      await backup(requireNativeSqliteDatabase(database.db), replacementPath);
      const { entered, release } = pauseConsentCommit();
      const outcome = captureOutcome(send);
      let replaced = false;
      try {
        await entered.promise;
        renameSync(databasePath, displacedPath);
        renameSync(replacementPath, databasePath);
        replaced = true;
        release.resolve();
        const rejection = await outcome;
        await closeOpenClawAgentDatabasesAsync();
        for (const storePath of [databasePath, displacedPath]) {
          expect(
            listSessionEntries({ agentId: "main", env: state.env, storePath, readOnly: true }),
          ).toEqual([]);
        }
        expect(rejection).toEqual(expect.any(Error));
        expect(String(rejection)).toContain(
          "Reply initialization database changed after its snapshot",
        );
        expect(respond).not.toHaveBeenCalled();
        expect(context.chatAbortControllers.size).toBe(0);
      } finally {
        release.resolve();
        await outcome;
        await closeOpenClawAgentDatabasesAsync();
        if (replaced) {
          renameSync(databasePath, replacementPath);
          renameSync(displacedPath, databasePath);
        }
        if (existsSync(replacementPath)) {
          unlinkSync(replacementPath);
        }
      }
    }),
);
