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
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
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
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { GatewayClient, RespondFn } from "./types.js";

vi.mock("./chat-send-admission.js", () => ({
  admitChatSend: () => {
    throw new Error("Refused native input must not enter send admission");
  },
}));
useNativeProcessFixture();

type TestState = Parameters<Parameters<typeof withOpenClawTestState>[1]>[0];
async function withNative(
  run: (state: TestState, config: OpenClawConfig, client: GatewayClient) => Promise<void>,
  prepare?: (config: OpenClawConfig) => GatewayClient,
) {
  await withOpenClawTestState({ label: "chat-native-consent" }, async (state) => {
    const config: OpenClawConfig = {
      tools: { profile: "full", deny: ["browser"] },
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          model: { primary: "acp-opencode/selected" },
          models: { "acp-opencode/selected": { agentRuntime: { id: "acp-opencode" } } },
        },
      },
    };
    const client = prepare?.(config) ?? nativeClient();
    using _ = prepare
      ? { [Symbol.dispose]: (await prepareUserProfileCatalog()).release }
      : undefined;
    await state.writeConfig(config);
    const native = await registerNative(state, config, "owner-agent.mjs");
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => native.service.stop?.(native.context));
    await run(state, config, client);
  });
}

function nativeClient(scopes = ["operator.admin"], user?: string): GatewayClient {
  const { authenticatedUserId: _, ...client } = sharingPolicyClient({ scopes, user });
  return { ...client, connId: "native-consent-client" };
}

function sendNative(
  config: OpenClawConfig,
  client = nativeClient(),
  sessionKey = "agent:main:main",
  isWebchat = true,
) {
  const respond = vi.fn<RespondFn>();
  const context = createDirectChatContext({ getRuntimeConfig: () => config });
  const handler = expectDefined(coreGatewayHandlers["chat.send"], "registered chat.send");
  const send = () =>
    handler({
      req: { type: "req", id: "native-consent-request", method: "chat.send" },
      params: { sessionKey, agentId: "main", message: "pending", idempotencyKey: "consent" },
      respond,
      context,
      client,
      isWebchatConnect: () => isWebchat,
    });
  return { respond, context, send };
}

async function withPausedConsent(
  send: () => unknown,
  run: (settle: () => Promise<unknown>) => Promise<void>,
) {
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
  const outcome = Promise.resolve(send()).catch((error: unknown) => error);
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(async () => {
    release.resolve();
    await outcome;
  });
  await entered.promise;
  await run(() => {
    release.resolve();
    return outcome;
  });
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

it.each([false, true])("gates native input persistence (existing=%s)", (preseed) =>
  withNative(async (_state, config, client) => {
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
    const { respond, send } = sendNative(config, client, target.sessionKey, false);
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
    const transcript = { ...target, sessionId: persisted.sessionId };
    const messages = await readVisibleSessionTranscriptMessageEntries(transcript);
    expect(messages).toEqual([]);
    expect(persisted.nativeRuntimeConsent).toBeUndefined();
    if (!preseed) {
      expect(persisted.lifecycleRevision).toBeTypeOf("string");
      const { providerOverride, modelOverride, agentRuntimeOverride } = persisted;
      expect([providerOverride, modelOverride, agentRuntimeOverride]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    }
    expect(rpcSourceTesting.size).toBe(0);
  }),
);

it.each([
  { kind: "non-admin", reason: "tool-policy" },
  { kind: "creator sandbox", reason: "sandbox-required" },
  { kind: "execution sandbox", reason: "sandbox-required" },
  { kind: "remote execution", reason: "remote-execution" },
] as const)("refuses $kind without a consent row", ({ kind, reason }) =>
  withNative(
    async (_state, config, client) => {
      const { respond, send } = sendNative(config, client);
      await send();
      restricted(respond, reason);
      expect(respond.mock.calls[0]?.[2]?.details).not.toHaveProperty("recovery");
      expect(listSessionEntries({ agentId: "main", readOnly: true })).toEqual([]);
      expect(rpcSourceTesting.size).toBe(0);
    },
    (config) => {
      const profile = ensureProfileForEmail("native-creator@example.test");
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
      return nativeClient(kind === "non-admin" ? ["operator.write"] : undefined, profile.id);
    },
  ),
);

it.each(["authority", "mandatory policy", "competing entry"] as const)(
  "rechecks $change before first-send consent commit",
  (change) =>
    withNative(async (_state, config, client) => {
      const { send } = sendNative(config, client);
      const sessionKey = "agent:main:main";
      const competing = {
        sessionKey,
        entry: { sessionId: "competing-session", label: "Keep competing entry" },
      };
      await withPausedConsent(send, async (settle) => {
        if (change === "authority") {
          client.connect.scopes = ["operator.write"];
        } else if (change === "mandatory policy") {
          config.tools = { ...config.tools, exec: { host: "sandbox" } };
        } else {
          await upsertSessionEntry({
            agentId: "main",
            ...competing,
            entry: { ...competing.entry, updatedAt: 1 },
          });
        }
        await settle();
        const entries = listSessionEntries({ agentId: "main", readOnly: true });
        expect(entries).toMatchObject(change === "competing entry" ? [competing] : []);
        expect(entries.every(({ entry }) => entry.nativeRuntimeConsent === undefined)).toBe(true);
        expect(rpcSourceTesting.size).toBe(0);
      });
    }),
);

it.runIf(process.platform !== "win32")("rejects consent after database-owner replacement", () =>
  withNative(async (state, config) => {
    const { respond, send } = sendNative(config);
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    const replacementPath = `${databasePath}.native-replacement`;
    const displacedPath = `${databasePath}.native-original`;
    await backup(requireNativeSqliteDatabase(database.db), replacementPath);
    let replaced = false;
    try {
      await withPausedConsent(send, async (settle) => {
        renameSync(databasePath, displacedPath);
        renameSync(replacementPath, databasePath);
        replaced = true;
        const rejection = await settle();
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
        expect(rpcSourceTesting.size).toBe(0);
      });
    } finally {
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
