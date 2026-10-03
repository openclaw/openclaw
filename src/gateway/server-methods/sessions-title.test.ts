import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { connectUserModelAccount } from "../../state/user-model-accounts.js";
import * as profileReader from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { sessionTitleHandlers } from "./sessions-title.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  runIsolatedCompletion: vi.fn(),
  resolveRegisteredCatalogCreateTarget: vi.fn(),
}));

vi.mock("../../agents/isolated-completion.js", () => ({
  runIsolatedCompletion: mocks.runIsolatedCompletion,
}));
vi.mock("./session-catalog.js", () => ({
  resolveRegisteredCatalogCreateTarget: mocks.resolveRegisteredCatalogCreateTarget,
}));

const cfg: OpenClawConfig = {
  agents: {
    entries: { main: {} },
    defaults: {
      model: { primary: "title-test/primary" },
      utilityModel: "title-test/utility",
    },
  },
};

function operatorModelConfig(allow: string[]): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models: {
          "title-test/primary": {},
          "title-test/utility": {},
          "title-test/blocked": { alias: "hidden-title-model" },
        },
      },
    },
    gateway: {
      roles: {
        default: "limited",
        definitions: {
          limited: {
            agents: "*",
            scopes: ["operator.write"],
            sessions: { others: "none" },
            modelPolicy: { sourceAgent: "main", allow },
          },
        },
      },
    },
  };
}

function utilityModelConfig(utilityModel: string): OpenClawConfig {
  return {
    ...cfg,
    agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, utilityModel } },
  };
}

let testState: OpenClawTestState;
let ownerId: string;
let otherId: string;
let personalAccountId: string;

function connectedClient(profileId?: string): GatewayClient {
  return {
    connId: "title-preparation-connection",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.write"],
    },
    ...(profileId
      ? {
          authenticatedUserProfile: {
            profileId,
            displayName: "Title Test Person",
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  };
}

async function prepare(
  params: Record<string, unknown>,
  config: OpenClawConfig = cfg,
  client: GatewayClient | null = null,
  controls: { connections?: ReadonlySet<GatewayClient>; signal?: AbortSignal } = {},
) {
  const respond = vi.fn();
  const method = "sessions.title.prepare";
  const connections = controls.connections ?? new Set(client ? [client] : []);
  const context: Pick<GatewayRequestContext, "getRuntimeConfig" | "getClientConnIds"> = {
    getRuntimeConfig: () => config,
    getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) => {
      const connIds = new Set<string>();
      for (const candidate of connections) {
        if (candidate.connId && (!filter || filter(candidate))) {
          connIds.add(candidate.connId);
        }
      }
      return connIds;
    },
  };
  await sessionTitleHandlers[method]!({
    req: { type: "req", id: "draft-title", method, params },
    params,
    respond,
    context: context as GatewayRequestContext,
    client,
    signal: controls.signal,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("sessions.title.prepare", () => {
  beforeAll(async () => {
    testState = await createOpenClawTestState({ scenario: "minimal" });
    ownerId = ensureProfileForEmail("title-owner@example.test").id;
    otherId = ensureProfileForEmail("title-other@example.test").id;
    personalAccountId = connectUserModelAccount({
      ownerProfileId: ownerId,
      credential: { type: "token", provider: "title-test", token: "synthetic-title-token" },
      assertCurrent() {},
    }).authProfileId;
  });

  afterAll(async () => {
    await testState.cleanup();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.runIsolatedCompletion.mockResolvedValue({ text: 'Title: "Draft session title"' });
    mocks.resolveRegisteredCatalogCreateTarget.mockReturnValue({
      ok: false,
      unknownCatalog: true,
      message: "unknown catalog",
    });
  });

  it.each(["params", "connection"] as const)(
    "retains the original title request across profile preparation when %s changes",
    async (change) => {
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const originalPrepare = profileReader.prepareUserProfileIdentity;
      const releases: ReturnType<typeof vi.fn>[] = [];
      const spy = vi
        .spyOn(profileReader, "prepareUserProfileIdentity")
        .mockImplementation(async (...args) => {
          const prepared = await originalPrepare(...args);
          const release = vi.fn(prepared.release);
          prepared.release = release;
          releases.push(release);
          entered.resolve();
          await resume.promise;
          return prepared;
        });
      const params = {
        agentId: "main",
        message: "Original title request",
        model: "title-test/primary",
      };
      const client = connectedClient(ownerId);
      const running = prepare(params, cfg, client).then(
        (respond) => ({ respond }),
        (error: unknown) => ({ error }),
      );
      try {
        await entered.promise;
        if (change === "params") {
          params.message = "Replacement title request";
          params.model = "title-test/blocked";
        } else {
          client.invalidated = true;
        }
        resume.resolve();
        const result = await running;
        if (change === "params") {
          expect(result).toHaveProperty("respond");
          expect(mocks.runIsolatedCompletion).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              prompt: "Original title request",
            }),
          );
        } else {
          expect(result).toHaveProperty("error");
          expect(mocks.runIsolatedCompletion).not.toHaveBeenCalled();
        }
        expect(releases).toHaveLength(1);
        expect(releases[0]).toHaveBeenCalledOnce();
      } finally {
        resume.resolve();
        await running;
        spy.mockRestore();
      }
    },
  );

  it.each<{
    name: string;
    params?: Record<string, unknown>;
    config?: OpenClawConfig;
    profile?: "owner" | "foreign" | "delegated" | "unidentified";
    personal?: boolean;
    error?: "INVALID_REQUEST" | "FORBIDDEN";
  }>([
    ...["", "invalid/"].map((utilityModel) => ({
      name: `disabled or malformed utility ${JSON.stringify(utilityModel)}`,
      config: utilityModelConfig(utilityModel),
      params: { message: "Plan a session" },
    })),
    { name: "blank input", params: { message: "   " } },
    { name: "slash command", params: { message: "/new" } },
    { name: "incognito input", params: { message: "Secret draft", incognito: true } },
    { name: "unknown catalog", params: { message: "Catalog draft", catalogId: "missing" } },
    ...(
      [
        ["unknown agent", { agentId: "missing" }],
        ["oversized input", { message: "x".repeat(1_001) }],
        ["existing session target", { sessionKey: "existing-session" }],
        ["model and catalog conflict", { model: "title-test/primary", catalogId: "catalog" }],
      ] as const
    ).map(([name, params]) => ({ name, params, error: "INVALID_REQUEST" as const })),
    {
      name: "denied creation agent",
      config: {
        ...cfg,
        gateway: {
          roles: {
            default: "limited",
            definitions: {
              limited: { agents: [], scopes: ["operator.write"], sessions: { others: "none" } },
            },
          },
        },
      },
      profile: "owner",
      error: "FORBIDDEN",
    },
    ...["title-test/blocked", "hidden-title-model"].map((model) => ({
      name: `denied operator model ${model}`,
      params: { model },
      config: operatorModelConfig(["title-test/primary", "title-test/utility"]),
      profile: "owner" as const,
      error: "FORBIDDEN" as const,
    })),
    {
      name: "denied operator utility without primary fallback",
      params: { model: "title-test/primary" },
      config: operatorModelConfig(["title-test/primary"]),
      profile: "owner",
    },
    {
      name: "denied creation-agent model",
      params: { model: "other-model/denied" },
      config: {
        ...cfg,
        agents: {
          ...cfg.agents,
          entries: { main: { modelPolicy: { allow: ["title-test/primary"] } } },
        },
      },
    },
    ...(["foreign", "delegated", "unidentified"] as const).map((profile) => ({
      name: `${profile} personal account`,
      params: { message: "Personal draft" },
      profile,
      personal: true,
      error: "FORBIDDEN" as const,
    })),
  ])("avoids inference for $name", async ({ params, config, profile, personal, error }) => {
    const client = profile
      ? connectedClient(
          profile === "foreign" ? otherId : profile === "unidentified" ? undefined : ownerId,
        )
      : null;
    if (client && profile === "delegated") {
      client.internal = {
        syntheticClient: true,
        agentToolCaller: { agentId: "main", sessionKey: "agent:main:dashboard:delegated-title" },
      };
    }
    const respond = await prepare(
      {
        agentId: "main",
        message: "Draft",
        ...params,
        ...(personal ? { model: `title-test/primary@${personalAccountId}` } : {}),
      },
      config,
      client,
    );
    if (error) {
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: error }),
      );
    } else {
      expect(respond).toHaveBeenCalledWith(true, { title: null });
    }
    expect(mocks.runIsolatedCompletion).not.toHaveBeenCalled();
  });

  it.each<{
    name: string;
    message?: string;
    model?: string;
    config?: OpenClawConfig;
    connected?: boolean;
    personal?: boolean;
    catalog?: boolean;
    provider?: string;
    utility?: string;
    runtime?: "codex";
    operator?: boolean;
    fails?: boolean;
  }>([
    { name: "default utility", message: "Plan a new session" },
    {
      name: "same-provider auth profile",
      model: "title-test/primary@work",
    },
    {
      name: "connected personal account",
      message: "Personal draft",
      connected: true,
      personal: true,
    },
    {
      name: "cross-provider utility without primary credentials",
      model: "title-test/primary@work",
      config: utilityModelConfig("other-title/utility"),
      provider: "other-title",
    },
    ...(
      [
        ["openai", "codex"],
        ["other-title", undefined],
      ] as const
    ).map(([provider, runtime]) => ({
      name: `${provider} catalog runtime`,
      config: utilityModelConfig(`${provider}/synthetic-utility`),
      catalog: true,
      provider,
      utility: "synthetic-utility",
      runtime,
    })),
    {
      name: "operator-allowed utility",
      model: "title-test/primary",
      config: operatorModelConfig(["title-test/primary", "title-test/utility"]),
      connected: true,
      operator: true,
    },
    { name: "failed automatic inference", message: "Private draft", connected: true, fails: true },
    {
      name: "failed personal inference",
      message: "Private draft",
      connected: true,
      personal: true,
      fails: true,
    },
  ])("uses only utility inference for $name", async (selection) => {
    if (selection.fails) {
      mocks.runIsolatedCompletion.mockRejectedValue(new Error("private provider diagnostic"));
    }
    if (selection.catalog) {
      mocks.resolveRegisteredCatalogCreateTarget.mockReturnValue({
        ok: true,
        target: {
          model: "openai/synthetic-primary",
          agentRuntime: "codex",
          pluginOwnerId: "codex",
        },
      });
    }
    const respond = await prepare(
      {
        agentId: "main",
        message: selection.message ?? "Draft",
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.personal ? { model: `title-test/primary@${personalAccountId}` } : {}),
        ...(selection.catalog ? { catalogId: "native-catalog" } : {}),
      },
      selection.config,
      selection.connected ? connectedClient(ownerId) : null,
    );
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
      title: selection.fails ? null : "Draft session title",
    });
    if (selection.fails) {
      expect(mocks.runIsolatedCompletion).toHaveBeenCalledTimes(1);
    } else {
      expect(mocks.runIsolatedCompletion).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          provider: selection.provider ?? "title-test",
          model: selection.utility ?? "utility",
          prompt: selection.message ?? "Draft",
          outputTextPolicy: "strict-visible",
          ...(selection.personal
            ? { authProfileId: personalAccountId }
            : selection.model === "title-test/primary@work"
              ? { authProfileId: selection.provider ? undefined : "work" }
              : {}),
          ...(selection.operator
            ? { operatorAuthority: expect.objectContaining({ profileId: ownerId }) }
            : {}),
        }),
      );
      if (selection.catalog) {
        expect(mocks.runIsolatedCompletion.mock.calls[0]?.[0].agentHarnessRuntimeOverride).toBe(
          selection.runtime,
        );
      }
    }
  });

  it.each([
    { loss: "disconnected", completion: "succeeds" },
    { loss: "replaced", completion: "succeeds" },
    { loss: "role revoked", completion: "succeeds" },
    { loss: "agent access revoked", completion: "succeeds" },
    { loss: "request aborted", completion: "succeeds" },
    { loss: "disconnected", completion: "fails" },
  ] as const)(
    "rejects a $loss personal selection when pending inference $completion",
    async ({ loss, completion }) => {
      const writer: GatewayOperatorRoleDefinition = {
        agents: "*",
        scopes: ["operator.write"],
        sessions: { others: "none" },
      };
      const config: OpenClawConfig = {
        ...cfg,
        gateway: { roles: { default: "writer", definitions: { writer } } },
      };
      const client = connectedClient(ownerId);
      const connections = new Set([client]);
      const abort = new AbortController();
      const inference = createDeferredCore<{ text: string }>();
      mocks.runIsolatedCompletion.mockReturnValueOnce(inference.promise);
      const pending = prepare(
        {
          agentId: "main",
          message: "Personal draft",
          model: `title-test/primary@${personalAccountId}`,
        },
        config,
        client,
        { connections, signal: abort.signal },
      );
      try {
        await vi.waitFor(() => expect(mocks.runIsolatedCompletion).toHaveBeenCalledOnce());
        if (loss === "disconnected" || loss === "replaced") {
          connections.delete(client);
          if (loss === "replaced") {
            connections.add(connectedClient(ownerId));
          }
        } else if (loss === "role revoked") {
          writer.scopes = ["operator.read"];
        } else if (loss === "agent access revoked") {
          writer.agents = [];
        } else {
          abort.abort();
        }
      } finally {
        if (completion === "fails") {
          inference.reject(new Error("private provider diagnostic"));
        } else {
          inference.resolve({ text: "Title after authority ended" });
        }
      }
      expect(await pending).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
      expect(mocks.runIsolatedCompletion).toHaveBeenCalledTimes(1);
    },
  );
});
