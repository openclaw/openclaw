import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type {
  UsersAuthConnectStartResult,
  UsersAuthConnectStatusResult,
} from "../../../packages/gateway-protocol/src/schema/users.js";
import type { AuthProfileCredential, OAuthCredential } from "../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthResult,
} from "../../plugins/types.js";
import type { UserProfileAuthLink } from "../../state/user-model-accounts.js";
import { createModelAccountConnectService } from "../model-account-connect.js";
import { broadcastChatMetadataChanged } from "../server-chat-metadata-lifecycle.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";
import { usersHandlers } from "./users.js";

const resolveProfileId = vi.hoisted(() => vi.fn());
const prepareUserProfileSelectionAuthority = vi.hoisted(() => vi.fn());
const connectUserModelAccount = vi.hoisted(() => vi.fn());
const listUserProfileAuthLinks = vi.hoisted(() => vi.fn());
const listUserModelAccounts = vi.hoisted(() => vi.fn());
const readUserModelAccountSummary = vi.hoisted(() => vi.fn());
const readSelectedUserModelAccount = vi.hoisted(() => vi.fn());
const setUserProfileAuthLink = vi.hoisted(() => vi.fn());
const clearUserProfileAuthLink = vi.hoisted(() => vi.fn());
const ensureAuthProfileStoreWithoutExternalProfiles = vi.hoisted(() => vi.fn());
const registerSecretValueForRedaction = vi.hoisted(() => vi.fn());
const listPersonalAccountAuthChoices = vi.hoisted(() => vi.fn());
const resolvePersonalAccountAuthMethod = vi.hoisted(() => vi.fn());
const exchange = vi.hoisted(() => vi.fn());
const modelAccountLinksCurrent = vi.hoisted(() => vi.fn());

export {
  resolveProfileId,
  prepareUserProfileSelectionAuthority,
  connectUserModelAccount,
  listUserProfileAuthLinks,
  listUserModelAccounts,
  readUserModelAccountSummary,
  readSelectedUserModelAccount,
  setUserProfileAuthLink,
  clearUserProfileAuthLink,
  ensureAuthProfileStoreWithoutExternalProfiles,
  registerSecretValueForRedaction,
  resolvePersonalAccountAuthMethod,
  exchange,
  modelAccountLinksCurrent,
};

function selectionAuthority(reference: string) {
  const profileId = resolveProfileId(reference);
  return {
    profileId,
    isCurrent: () =>
      resolveProfileId(reference) === profileId && resolveProfileId(profileId) === profileId,
  };
}

vi.mock("../../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profile-list.js")>()),
  captureResidentUserProfileAccess: (profileId: string) => ({
    assertCurrent: () => ({ id: resolveProfileId(profileId), role: null, githubLogin: null }),
  }),
}));
vi.mock("../../state/user-channel-identity-operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-channel-identity-operations.js")>()),
  prepareUserProfileSelectionAuthority,
  prepareUserProfileRolePolicyAuthority: async (reference: string) => ({
    ...selectionAuthority(reference),
    role: null,
    githubLogin: null,
  }),
}));
vi.mock("../../state/user-profile-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profile-events.js")>()),
  captureUserProfileModelAccountLinksAuthority: () => modelAccountLinksCurrent,
}));
vi.mock("../../state/user-profile-email.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profile-email.js")>()),
  ensureProfileIdForEmail: async () => "profile-1",
}));
vi.mock("../../state/openclaw-state-worker-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-state-worker-context.js")>()),
  captureOpenClawStateWorkerContext: () => ({}),
}));
vi.mock("../../state/user-model-account-operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-model-account-operations.js")>()),
  connectUserModelAccountAsync: connectUserModelAccount,
  listUserProfileAuthLinksAsync: listUserProfileAuthLinks,
  listUserModelAccountsAsync: listUserModelAccounts,
  readUserModelAccountSummaryAsync: readUserModelAccountSummary,
  readSelectedUserModelAccountAsync: readSelectedUserModelAccount,
  setUserProfileAuthLinkAsync: setUserProfileAuthLink,
  clearUserProfileAuthLinkAsync: clearUserProfileAuthLink,
}));
vi.mock("../../agents/auth-profiles/shared-main-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/shared-main-dir.js")>()),
  resolveSharedMainAuthAgentDir: () => "/tmp/shared-main-agent",
}));
vi.mock("../../agents/auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/store-runtime.js")>()),
  ensureAuthProfileStoreWithoutExternalProfiles,
  ensureAuthProfileStoreWithoutExternalProfilesAsync: async (...args: unknown[]) =>
    ensureAuthProfileStoreWithoutExternalProfiles(...args),
}));
vi.mock("../../logging/secret-redaction-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logging/secret-redaction-registry.js")>()),
  registerSecretValueForRedaction,
}));
vi.mock("../../plugins/personal-account-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/personal-account-auth.js")>()),
  listPersonalAccountAuthChoices,
  resolvePersonalAccountAuthMethod,
}));

type TestClient = GatewayClient & { connId: string; invalidated: boolean };
type ConnectTestContext = Pick<
  GatewayRequestContext,
  | "broadcast"
  | "logGateway"
  | "modelAccountConnectService"
  | "getRuntimeConfig"
  | "getClientConnIds"
>;
export const credential: OAuthCredential = {
  type: "oauth",
  provider: "openai",
  access: "synthetic-access",
  refresh: "synthetic-refresh",
  accountId: "workspace-1",
  expires: 123,
  clientId: "synthetic-client",
  authorizationScope: "openid profile resource.invoke offline_access",
};
export const authorized: ProviderAuthResult = {
  profiles: [{ profileId: "openai:ignored-shared-id", credential }],
};
export const runAuth = vi.fn(async (ctx: ProviderAuthContext) => {
  const value = await ctx.prompter.text({
    message: "Provider credential",
    sensitive: true,
    validate: (answer) => (answer === "synthetic-code" ? undefined : `Invalid: ${answer}`),
  });
  return exchange(value, ctx.signal);
});
const oauthMethod: ProviderAuthMethod = {
  id: "oauth",
  label: "Browser sign-in",
  kind: "oauth",
  run: runAuth,
};
export const broadcast = vi.fn();
export const warn = vi.fn();
export let service: ReturnType<typeof createModelAccountConnectService>;
let context: ConnectTestContext;
export let config: OpenClawConfig;
export let clients: Set<TestClient>;
export let self: TestClient;
export let writes: AuthProfileCredential[];
export let linksByOwner: Map<string, UserProfileAuthLink[]>;

export function createClient(profileId = "profile-1", scopes = ["operator.write"]): TestClient {
  const client: TestClient = {
    connId: `connection-${clients.size + 1}`,
    invalidated: false,
    authenticatedUserProfile: gatewayProfile(profileId, "Ada"),
    connect: gatewayConnect(scopes, { id: "test", mode: "test", version: "1" }),
  };
  clients.add(client);
  return client;
}

export async function rpc(
  requestMethod: string,
  params: Record<string, unknown>,
  client: TestClient = self,
) {
  const respond = vi.fn();
  await expectDefined(
    usersHandlers[requestMethod],
    `${requestMethod} test invariant`,
  )({
    req: { type: "req", id: "connect-test", method: requestMethod, params },
    client,
    context: context as GatewayRequestContext,
    params,
    respond,
    isWebchatConnect: () => false,
  });
  return respond;
}
export function flowRpc(
  action: "answer" | "cancel" | "status",
  flow: UsersAuthConnectStartResult,
  params: Record<string, unknown> = {},
  profileId = "profile-1",
  client = self,
) {
  return rpc(
    `users.authConnect.${action}`,
    { profileId, connectId: flow.connectId, ...params },
    client,
  );
}
export async function startFlow(
  profileId = "profile-1",
  client = self,
  provider = "openai",
  method = "oauth",
): Promise<UsersAuthConnectStartResult> {
  const respond = await rpc("users.authConnect.start", { profileId, provider, method }, client);
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ connectId: expect.any(String) }),
  );
  const flow = respond.mock.calls[0]?.[1] as UsersAuthConnectStartResult;
  await vi.waitFor(async () =>
    expect(await status(flow, profileId, client)).toMatchObject({
      status: "pending",
      step: { type: "text" },
    }),
  );
  return flow;
}
export async function complete(
  flow: UsersAuthConnectStartResult,
  profileId = "profile-1",
  client = self,
) {
  const current: UsersAuthConnectStatusResult = await status(flow, profileId, client);
  return flowRpc(
    "answer",
    flow,
    {
      stepId: current.status === "pending" ? current.step!.id : "retired-step",
      value: "synthetic-code",
    },
    profileId,
    client,
  );
}
export async function terminal(
  flow: UsersAuthConnectStartResult,
  expected: string,
  profileId = "profile-1",
  client = self,
) {
  await vi.waitFor(async () =>
    expect(await status(flow, profileId, client)).toMatchObject({ status: expected }),
  );
  return status(flow, profileId, client);
}
export async function status(
  flow: UsersAuthConnectStartResult,
  profileId = "profile-1",
  client = self,
) {
  const respond = await flowRpc("status", flow, {}, profileId, client);
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return respond.mock.calls[0]?.[1];
}

export function setupModelAccountConnectTest() {
  beforeEach(async () => {
    vi.clearAllMocks();
    broadcast.mockReset();
    modelAccountLinksCurrent.mockReturnValue(true);
    config = {};
    clients = new Set();
    self = createClient();
    writes = [];
    linksByOwner = new Map();
    listUserProfileAuthLinks.mockImplementation((owner: string) => linksByOwner.get(owner) ?? []);
    listUserModelAccounts.mockReset().mockReturnValue({ accounts: [] });
    readUserModelAccountSummary.mockReset();
    readSelectedUserModelAccount.mockReset();
    ensureAuthProfileStoreWithoutExternalProfiles
      .mockReset()
      .mockReturnValue({ version: 1, profiles: { "openai:shared": credential } });
    clearUserProfileAuthLink
      .mockReset()
      .mockImplementation(
        (params: { profileId: string; provider: string; assertCurrent?: () => void }) => {
          params.assertCurrent?.();
          const links = (linksByOwner.get(params.profileId) ?? []).filter(
            (link) => link.provider !== params.provider,
          );
          linksByOwner.set(params.profileId, links);
          return links;
        },
      );
    setUserProfileAuthLink
      .mockReset()
      .mockImplementation(
        (params: {
          profileId: string;
          provider: string;
          authProfileId: string;
          assertCurrent?: () => void;
        }) => {
          params.assertCurrent?.();
          const links = [
            { provider: params.provider, authProfileId: params.authProfileId, updatedAt: 2 },
          ];
          linksByOwner.set(params.profileId, links);
          return links;
        },
      );
    resolveProfileId.mockImplementation((id: string) => id);
    prepareUserProfileSelectionAuthority.mockImplementation(async (reference: string) =>
      selectionAuthority(reference),
    );
    listPersonalAccountAuthChoices.mockReturnValue([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "oauth",
        choiceLabel: "Browser sign-in",
        groupLabel: "OpenAI",
      },
    ]);
    resolvePersonalAccountAuthMethod.mockReturnValue(oauthMethod);
    exchange.mockResolvedValue(authorized);
    connectUserModelAccount.mockImplementation(
      (params: {
        ownerProfileId: string;
        credential: AuthProfileCredential;
        assertCurrent: () => void;
      }) => {
        params.assertCurrent();
        writes.push(params.credential);
        const authProfileId = `personal:${params.ownerProfileId}:account-1`;
        const links = [
          ...(linksByOwner.get(params.ownerProfileId) ?? []).filter(
            (link) => link.provider !== params.credential.provider,
          ),
          { provider: params.credential.provider, authProfileId, updatedAt: 1 },
        ];
        linksByOwner.set(params.ownerProfileId, links);
        return { authProfileId, links };
      },
    );
    service = createModelAccountConnectService({
      getConfig: () => config,
      onChanged: () => broadcastChatMetadataChanged(context),
    });
    context = {
      broadcast,
      logGateway: { ...createSubsystemLogger("gateway"), warn },
      modelAccountConnectService: service,
      getRuntimeConfig: () => config,
      getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
        new Set(
          [...clients]
            .filter((client) => !client.invalidated && (!filter || filter(client)))
            .map((client) => client.connId),
        ),
    };
  });
  afterEach(async () => {
    await service.stop();
    vi.restoreAllMocks();
  });
}

export function setConfig(next: OpenClawConfig) {
  config = next;
}

export function restartService() {
  service = createModelAccountConnectService({ getConfig: () => config });
  context.modelAccountConnectService = service;
}
