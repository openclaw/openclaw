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

function roleConfig(role: GatewayOperatorRoleDefinition, name = "limited"): OpenClawConfig {
  return { ...cfg, gateway: { roles: { default: name, definitions: { [name]: role } } } };
}

function operatorModelConfig(allow: string[]): OpenClawConfig {
  return {
    ...roleConfig({
      agents: "*",
      scopes: ["operator.write"],
      sessions: { others: "none" },
      modelPolicy: { sourceAgent: "main", allow },
    }),
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
let releaseProfileCatalog: (() => void) | undefined;

type TitleCase = {
  params?: Record<string, unknown>;
  config?: OpenClawConfig;
  profile?: "owner" | "foreign" | "delegated" | "unidentified";
  personal?: boolean;
  error?: "INVALID_REQUEST" | "FORBIDDEN";
  model?: string;
  connected?: boolean;
  catalog?: boolean;
  provider?: string;
  utility?: string;
  runtime?: "codex";
  operator?: boolean;
  fails?: boolean;
  infer?: boolean;
};
const titleCase = (name: string, options: TitleCase = {}) => ({ name, ...options });

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
    authenticatedUserProfile: profileId
      ? { profileId, displayName: "Title Test Person", hasAvatar: false, updatedAt: 1 }
      : undefined,
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
      return new Set(
        [...connections].flatMap((candidate) =>
          candidate.connId && (!filter || filter(candidate)) ? [candidate.connId] : [],
        ),
      );
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
    testState = await createOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true });
    ownerId = ensureProfileForEmail("title-owner@example.test").id;
    otherId = ensureProfileForEmail("title-other@example.test").id;
    releaseProfileCatalog = (await profileReader.prepareUserProfileCatalog()).release;
    personalAccountId = connectUserModelAccount({
      ownerProfileId: ownerId,
      credential: { type: "token", provider: "title-test", token: "synthetic-title-token" },
      assertCurrent() {},
    }).authProfileId;
  });

  afterAll(async () => {
    releaseProfileCatalog?.();
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
              prompt: expect.stringContaining("Original title request"),
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

  const withoutInference = [
    ...["", "invalid/"].map((utilityModel) =>
      titleCase(`disabled or malformed utility ${JSON.stringify(utilityModel)}`, {
        config: utilityModelConfig(utilityModel),
      }),
    ),
    titleCase("blank input", { params: { message: "   " } }),
    titleCase("slash command", { params: { message: "/new" } }),
    titleCase("incognito input", { params: { incognito: true } }),
    titleCase("unknown catalog", { params: { catalogId: "missing" } }),
    ...(
      [
        ["unknown agent", { agentId: "missing" }],
        ["oversized input", { message: "x".repeat(1_001) }],
        ["existing session target", { sessionKey: "existing-session" }],
        ["model and catalog conflict", { model: "title-test/primary", catalogId: "catalog" }],
      ] as const
    ).map(([name, params]) => titleCase(name, { params, error: "INVALID_REQUEST" })),
    titleCase("denied creation agent", {
      config: roleConfig({ agents: [], scopes: ["operator.write"], sessions: { others: "none" } }),
      profile: "owner",
      error: "FORBIDDEN",
    }),
    ...["title-test/blocked", "hidden-title-model"].map((model) =>
      titleCase(`denied operator model ${model}`, {
        params: { model },
        config: operatorModelConfig(["title-test/primary", "title-test/utility"]),
        profile: "owner",
        error: "FORBIDDEN",
      }),
    ),
    titleCase("denied operator utility without primary fallback", {
      params: { model: "title-test/primary" },
      config: operatorModelConfig(["title-test/primary"]),
      profile: "owner",
    }),
    titleCase("denied creation-agent model", {
      params: { model: "other-model/denied" },
      config: {
        ...cfg,
        agents: {
          ...cfg.agents,
          entries: { main: { modelPolicy: { allow: ["title-test/primary"] } } },
        },
      },
    }),
    ...(["foreign", "delegated", "unidentified"] as const).map((profile) =>
      titleCase(`${profile} personal account`, { profile, personal: true, error: "FORBIDDEN" }),
    ),
  ];

  const withInference = [
    titleCase("default utility"),
    titleCase("same-provider auth profile", { model: "title-test/primary@work" }),
    titleCase("connected personal account", { connected: true, personal: true }),
    titleCase("cross-provider utility without primary credentials", {
      model: "title-test/primary@work",
      config: utilityModelConfig("other-title/utility"),
      provider: "other-title",
    }),
    ...(
      [
        ["openai", "codex"],
        ["other-title", undefined],
      ] as const
    ).map(([provider, runtime]) =>
      titleCase(`${provider} catalog runtime`, {
        config: utilityModelConfig(`${provider}/synthetic-utility`),
        catalog: true,
        provider,
        utility: "synthetic-utility",
        runtime,
      }),
    ),
    titleCase("operator-allowed utility", {
      model: "title-test/primary",
      config: operatorModelConfig(["title-test/primary", "title-test/utility"]),
      connected: true,
      operator: true,
    }),
    titleCase("failed automatic inference", { connected: true, fails: true }),
    titleCase("failed personal inference", { connected: true, personal: true, fails: true }),
  ];
  it.each([
    ...withoutInference,
    ...withInference.map((selection) => Object.assign(selection, { infer: true })),
  ])("selects utility inference for $name", async (selection) => {
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
    const profile = selection.profile ?? (selection.connected ? "owner" : undefined);
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
        ...selection.params,
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.personal ? { model: `title-test/primary@${personalAccountId}` } : {}),
        ...(selection.catalog ? { catalogId: "native-catalog" } : {}),
      },
      selection.config,
      client,
    );
    if (selection.error) {
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: selection.error }),
      );
    } else {
      expect(respond).toHaveBeenCalledWith(true, {
        title: selection.infer && !selection.fails ? "Draft session title" : null,
      });
    }
    expect(mocks.runIsolatedCompletion).toHaveBeenCalledTimes(selection.infer ? 1 : 0);
    if (selection.infer) {
      expect(respond).toHaveBeenCalledTimes(1);
    }
    if (selection.infer && !selection.fails) {
      expect(mocks.runIsolatedCompletion).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          provider: selection.provider ?? "title-test",
          model: selection.utility ?? "utility",
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
      const config = roleConfig(writer, "writer");
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
