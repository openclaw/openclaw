import { randomUUID } from "node:crypto";
import type {
  UsersAuthConnectCatalogResult,
  UsersAuthConnectStartResult,
  UsersAuthConnectStatusResult,
  UsersListAuthLinksResult,
  UsersLinkAuthProfileResult,
  UsersListModelAccountsResult,
  UsersSelectModelAccountResult,
  UsersUnlinkAuthProfileResult,
} from "../../packages/gateway-protocol/src/schema/users.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import { ensureAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { warnModelAccountConnectDeprecation } from "../plugins/compat/model-account-connect-deprecation.js";
import {
  listPersonalAccountAuthChoices,
  resolvePersonalAccountAuthMethod,
} from "../plugins/personal-account-auth.js";
import { runProviderPluginAuthMethodUnpersisted } from "../plugins/provider-auth-method.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import {
  clearUserProfileAuthLink,
  connectUserModelAccount,
  listUserModelAccounts,
  listUserProfileAuthLinks,
  readUserModelAccountSummary,
  readSelectedUserModelAccount,
  setUserProfileAuthLink,
} from "../state/user-model-account-operations.js";
import * as nativeAccounts from "../state/user-model-accounts.js";
import { captureUserProfileModelAccountLinksAuthority } from "../state/user-profile-events.js";
import { sanitizeWizardStepForClient, WizardSession } from "../wizard/session.js";
import type {
  ModelAccountConnectAction,
  ModelAccountConnectWorkerAction,
  ModelAccountRole,
} from "./model-account-authority.js";
import {
  ModelAccountConnectAuthorityError,
  ModelAccountConnectInputError,
} from "./model-account-connect-errors.js";

type TerminalResult =
  | Exclude<UsersAuthConnectStatusResult, { status: "pending" | "connected" }>
  | { status: "connected"; authProfileId: string };
type ConnectOperation = {
  id: string;
  owner: string;
  provider: string;
  expiresAtMs: number;
  action: ModelAccountConnectWorkerAction;
  answerAction?: ModelAccountConnectWorkerAction;
  timeout: NodeJS.Timeout;
  session?: WizardSession;
  settlement?: Promise<void>;
  terminal?: TerminalResult;
};

const CONNECT_TTL_MS = 15 * 60 * 1_000;
const MAX_ACTIVE_CONNECTS = 8;
const MAX_RETAINED_CONNECTS = 64;

function matchesLiteralCredential(
  credential: AuthProfileCredential,
  existing: AuthProfileCredential,
) {
  if (credential.provider !== existing.provider) {
    return false;
  }
  return credential.type === "api_key" && existing.type === "api_key"
    ? credential.key === existing.key
    : credential.type === "token" &&
        existing.type === "token" &&
        credential.token === existing.token;
}

async function resolveOwnedAccountProvider(
  owner: string,
  authProfileId: string,
  context: OpenClawStateWorkerContext,
): Promise<string> {
  return requireOwnedAccountProvider(
    await readUserModelAccountSummary({ profileId: owner, authProfileId }, { context }),
  );
}

function requireOwnedAccountProvider(account: nativeAccounts.UserModelAccount | undefined): string {
  if (!account) {
    throw new ModelAccountConnectInputError(
      "Select an account from your personal account list, or add it first.",
    );
  }
  return account.provider;
}

async function resolveLinkableAuthProfileProvider(
  cfg: OpenClawConfig,
  owner: string,
  authProfileId: string,
  context: OpenClawStateWorkerContext,
): Promise<string | undefined> {
  if (isUserModelAuthProfileId(authProfileId)) {
    return resolveOwnedAccountProvider(owner, authProfileId, context);
  }
  return resolveSharedAuthProfileProvider(cfg, authProfileId);
}

function resolveSharedAuthProfileProvider(cfg: OpenClawConfig, authProfileId: string) {
  // Stored credentials and config-only routes (e.g. aws-sdk) remain linkable;
  // the caller cannot claim a provider the selected profile does not satisfy.
  const store = ensureAuthProfileStoreWithoutExternalProfiles(resolveSharedMainAuthAgentDir(), {
    readOnly: true,
  });
  return store.profiles[authProfileId]?.provider ?? cfg.auth?.profiles?.[authProfileId]?.provider;
}

function requireLinkableProvider(provider: string | undefined, authProfileId: string): string {
  if (!provider) {
    throw new ModelAccountConnectInputError(
      `unknown auth profile "${authProfileId}"; sign the account in first with "openclaw models auth login --provider <id> --profile-id ${authProfileId}", then link it`,
    );
  }
  return provider;
}

/** One Gateway lifetime owns sign-in steps and authority; provider methods only stage credentials. */
export function createModelAccountConnectService(options: {
  getConfig: () => OpenClawConfig;
  onChanged?: () => void;
}) {
  const operations = new Map<string, ConnectOperation>();
  let stopped = false;
  const pendingWrites = new Set<Promise<unknown>>();
  let writeTail: Promise<unknown> = Promise.resolve();
  const retainWrite = <T>(write: () => Promise<T>): Promise<T> => {
    const pending = runOutsideAsyncWorkScope(() => writeTail.then(write));
    writeTail = pending.catch(() => {});
    pendingWrites.add(pending);
    void pending.finally(() => pendingWrites.delete(pending)).catch(() => {});
    return pending;
  };

  const finish = (operation: ConnectOperation, result: TerminalResult): TerminalResult => {
    // An acknowledged commit wins over cancellation that raced its worker reply.
    if (operation.terminal && result.status !== "connected") {
      return operation.terminal;
    }
    // Revoke before aborting provider I/O. A late callback must never regain
    // commit authority, including when the provider ignores cancellation.
    operation.terminal = result;
    clearTimeout(operation.timeout);
    operation.session?.cancel();
    return result;
  };
  const snapshot = (operation: ConnectOperation, roles?: readonly ModelAccountRole[]) => {
    if (operation.terminal) {
      return operation.terminal;
    }
    if (operation.expiresAtMs <= Date.now()) {
      return finish(operation, { status: "expired" });
    }
    try {
      operation.action.assertCurrent(roles);
      operation.answerAction?.assertCurrent(roles);
    } catch {
      return finish(operation, { status: "failed", reason: "authority" });
    }
    return undefined;
  };
  const assertRunning = (action: ModelAccountConnectAction) => {
    if (stopped) {
      throw new ModelAccountConnectAuthorityError();
    }
    action.assertCurrent();
  };
  const assertLive = (operation: ConnectOperation, roles?: readonly ModelAccountRole[]) => {
    if (
      (stopped && !operation.settlement) ||
      operations.get(operation.id) !== operation ||
      snapshot(operation, roles)
    ) {
      throw new ModelAccountConnectAuthorityError();
    }
  };
  const resultSnapshot = (
    operation: ConnectOperation,
  ): TerminalResult | Extract<UsersAuthConnectStatusResult, { status: "pending" }> => {
    const result = snapshot(operation);
    if (!result) {
      const step = operation.session?.getCurrentStep();
      return { status: "pending", ...(step ? { step: sanitizeWizardStepForClient(step) } : {}) };
    }
    return result;
  };
  const projectResult = (
    action: ModelAccountConnectAction,
    operation: ConnectOperation,
  ): UsersAuthConnectStatusResult => {
    const result = resultSnapshot(operation);
    if (result.status !== "connected") {
      return result;
    }
    assertRunning(action);
    return { ...result, links: nativeAccounts.listUserProfileAuthLinks(operation.owner) };
  };
  const projectResultAsync = async (
    action: ModelAccountConnectAction,
    operation: ConnectOperation,
  ): Promise<UsersAuthConnectStatusResult> => {
    const result = resultSnapshot(operation);
    if (result.status !== "connected") {
      return result;
    }
    // Replays retain the committed account, but never replay an obsolete default link.
    assertRunning(action);
    const links = await listUserProfileAuthLinks(operation.owner);
    assertRunning(action);
    return { ...result, links };
  };
  const findOperation = (action: ModelAccountConnectAction, connectId: string) => {
    assertRunning(action);
    const operation = operations.get(connectId);
    return operation?.owner === action.owner ? operation : undefined;
  };
  const supersede = (
    owner: string,
    provider: string,
    previous: Iterable<ConnectOperation> = operations.values(),
  ) => {
    for (const operation of previous) {
      if (operation.owner === owner && operation.provider === provider) {
        finish(operation, { status: "cancelled" });
      }
    }
  };
  const setLink = async (
    action: ModelAccountConnectWorkerAction,
    provider: string,
    authProfileId: string,
    context: OpenClawStateWorkerContext,
    previous: readonly ConnectOperation[],
  ) => {
    action.assertCurrent();
    const links = await setUserProfileAuthLink(
      {
        profileId: action.owner,
        provider,
        authProfileId,
        authorityProfileIds: action.actorProfileId ? [action.actorProfileId] : [],
        assertCurrent: action.assertCurrent,
      },
      { context },
    );
    supersede(action.owner, provider, previous);
    options.onChanged?.();
    action.assertCurrent();
    return { links };
  };
  const setLinkNative = (
    action: ModelAccountConnectAction,
    provider: string,
    authProfileId: string,
  ) => {
    const links = nativeAccounts.setUserProfileAuthLink({
      profileId: action.owner,
      provider,
      authProfileId,
      assertCurrent: () => assertRunning(action),
    });
    supersede(action.owner, provider);
    options.onChanged?.();
    return { links };
  };
  const cancelOperation = (action: ModelAccountConnectAction, connectId: string) => {
    const operation = findOperation(action, connectId);
    if (operation) {
      snapshot(operation);
      finish(operation, { status: "cancelled" });
    }
    return operation;
  };
  const beginClose = () => {
    stopped = true;
    for (const operation of operations.values()) {
      if (operation.settlement) {
        operation.session?.cancel();
      } else {
        finish(operation, { status: "cancelled" });
      }
    }
  };

  return {
    /** @deprecated Await listLinksAsync; synchronous SDK compatibility ends at the next SDK major. */
    listLinks(action: ModelAccountConnectAction): UsersListAuthLinksResult {
      warnModelAccountConnectDeprecation("listLinks");
      assertRunning(action);
      return { links: nativeAccounts.listUserProfileAuthLinks(action.owner) };
    },
    /** @deprecated Await linkAsync; synchronous SDK compatibility ends at the next SDK major. */
    link(action: ModelAccountConnectAction, authProfileId: string): UsersLinkAuthProfileResult {
      warnModelAccountConnectDeprecation("link");
      assertRunning(action);
      const provider = isUserModelAuthProfileId(authProfileId)
        ? requireOwnedAccountProvider(
            nativeAccounts.readUserModelAccountSummary({ profileId: action.owner, authProfileId }),
          )
        : resolveSharedAuthProfileProvider(options.getConfig(), authProfileId);
      return setLinkNative(action, requireLinkableProvider(provider, authProfileId), authProfileId);
    },
    /** @deprecated Await unlinkAsync; synchronous SDK compatibility ends at the next SDK major. */
    unlink(action: ModelAccountConnectAction, provider: string): UsersUnlinkAuthProfileResult {
      warnModelAccountConnectDeprecation("unlink");
      assertRunning(action);
      const links = nativeAccounts.clearUserProfileAuthLink({
        profileId: action.owner,
        provider,
        assertCurrent: () => assertRunning(action),
      });
      supersede(action.owner, provider);
      options.onChanged?.();
      return { links };
    },
    /** @deprecated Await listAsync; synchronous SDK compatibility ends at the next SDK major. */
    list(action: ModelAccountConnectAction, cursor?: string): UsersListModelAccountsResult {
      warnModelAccountConnectDeprecation("list");
      assertRunning(action);
      return {
        profileId: action.owner,
        ...nativeAccounts.listUserModelAccounts({ profileId: action.owner, cursor }),
        links: nativeAccounts.listUserProfileAuthLinks(action.owner),
      };
    },
    /** @deprecated Await selectAsync; synchronous SDK compatibility ends at the next SDK major. */
    select(
      action: ModelAccountConnectAction,
      authProfileId: string,
    ): UsersSelectModelAccountResult {
      warnModelAccountConnectDeprecation("select");
      assertRunning(action);
      return setLinkNative(
        action,
        requireOwnedAccountProvider(
          nativeAccounts.readUserModelAccountSummary({ profileId: action.owner, authProfileId }),
        ),
        authProfileId,
      );
    },
    /** @deprecated Await statusAsync; synchronous SDK compatibility ends at the next SDK major. */
    status(action: ModelAccountConnectAction, connectId: string): UsersAuthConnectStatusResult {
      warnModelAccountConnectDeprecation("status");
      const operation = findOperation(action, connectId);
      return operation ? projectResult(action, operation) : { status: "expired" };
    },
    /** @deprecated Await cancelAsync; synchronous SDK compatibility ends at the next SDK major. */
    cancel(action: ModelAccountConnectAction, connectId: string): UsersAuthConnectStatusResult {
      warnModelAccountConnectDeprecation("cancel");
      const operation = cancelOperation(action, connectId);
      return operation ? projectResult(action, operation) : { status: "expired" };
    },
    async listLinksAsync(action: ModelAccountConnectAction): Promise<UsersListAuthLinksResult> {
      assertRunning(action);
      const links = await listUserProfileAuthLinks(action.owner);
      assertRunning(action);
      return { links };
    },
    async linkAsync(
      action: ModelAccountConnectWorkerAction,
      authProfileId: string,
    ): Promise<UsersLinkAuthProfileResult> {
      assertRunning(action);
      const context = captureOpenClawStateWorkerContext();
      const previous = [...operations.values()];
      return retainWrite(async () => {
        const provider = await resolveLinkableAuthProfileProvider(
          options.getConfig(),
          action.owner,
          authProfileId,
          context,
        );
        return setLink(
          action,
          requireLinkableProvider(provider, authProfileId),
          authProfileId,
          context,
          previous,
        );
      });
    },
    async unlinkAsync(
      action: ModelAccountConnectWorkerAction,
      provider: string,
    ): Promise<UsersUnlinkAuthProfileResult> {
      assertRunning(action);
      const context = captureOpenClawStateWorkerContext();
      const previous = [...operations.values()];
      return retainWrite(async () => {
        const links = await clearUserProfileAuthLink(
          {
            profileId: action.owner,
            provider,
            authorityProfileIds: action.actorProfileId ? [action.actorProfileId] : [],
            assertCurrent: action.assertCurrent,
          },
          { context },
        );
        supersede(action.owner, provider, previous);
        options.onChanged?.();
        action.assertCurrent();
        return { links };
      });
    },
    async listAsync(
      action: ModelAccountConnectAction,
      cursor?: string,
    ): Promise<UsersListModelAccountsResult> {
      assertRunning(action);
      const context = captureOpenClawStateWorkerContext();
      const linksCurrent = captureUserProfileModelAccountLinksAuthority(
        context.admission,
        action.owner,
      );
      const accounts = await listUserModelAccounts(
        { profileId: action.owner, cursor },
        { context },
      );
      const links = await listUserProfileAuthLinks(action.owner, { context });
      assertRunning(action);
      if (!linksCurrent()) {
        throw new Error(
          "Personal account selection changed while listing accounts; retry the request.",
        );
      }
      return { profileId: action.owner, ...accounts, links };
    },
    catalog(action: ModelAccountConnectAction): UsersAuthConnectCatalogResult {
      assertRunning(action);
      const providers = new Map<string, UsersAuthConnectCatalogResult["providers"][number]>();
      for (const choice of listPersonalAccountAuthChoices(options.getConfig())) {
        let provider = providers.get(choice.providerId);
        if (!provider) {
          provider = {
            id: choice.providerId,
            label: choice.groupLabel ?? choice.providerId,
            methods: [],
          };
          providers.set(choice.providerId, provider);
        }
        if (!provider.methods.some((method) => method.id === choice.methodId)) {
          provider.methods.push({
            id: choice.methodId,
            label: choice.choiceLabel,
            ...(choice.choiceHint ? { hint: choice.choiceHint } : {}),
          });
        }
      }
      assertRunning(action);
      return { providers: [...providers.values()] };
    },
    async selectAsync(
      action: ModelAccountConnectWorkerAction,
      authProfileId: string,
    ): Promise<UsersSelectModelAccountResult> {
      assertRunning(action);
      const context = captureOpenClawStateWorkerContext();
      const previous = [...operations.values()];
      return retainWrite(async () => {
        const provider = await resolveOwnedAccountProvider(action.owner, authProfileId, context);
        return setLink(action, provider, authProfileId, context, previous);
      });
    },
    async start(
      action: ModelAccountConnectAction,
      provider: string,
      methodId: string,
    ): Promise<UsersAuthConnectStartResult> {
      assertRunning(action);
      const context = captureOpenClawStateWorkerContext();
      for (const operation of operations.values()) {
        snapshot(operation);
      }
      supersede(action.owner, provider);
      if (
        [...operations.values()].filter((operation) => !operation.terminal).length >=
        MAX_ACTIVE_CONNECTS
      ) {
        throw new Error("Too many model-account sign-ins are in progress; try again shortly.");
      }
      for (const [id, operation] of operations) {
        if (operations.size < MAX_RETAINED_CONNECTS) {
          break;
        }
        if (operation.terminal) {
          operations.delete(id);
        }
      }
      const id = randomUUID();
      const operation: ConnectOperation = {
        id,
        owner: action.owner,
        provider,
        action,
        expiresAtMs: Date.now() + CONNECT_TTL_MS,
        timeout: setTimeout(() => finish(operation, { status: "expired" }), CONNECT_TTL_MS),
      };
      operation.timeout.unref();
      operations.set(id, operation);
      let resolvedMethod;
      try {
        resolvedMethod = await resolvePersonalAccountAuthMethod(
          options.getConfig(),
          provider,
          methodId,
        );
        assertLive(operation);
        if (!resolvedMethod) {
          throw new ModelAccountConnectInputError(
            "This sign-in method is unavailable for personal accounts. Choose a method from Connected accounts.",
          );
        }
      } catch (error) {
        snapshot(operation);
        finish(operation, { status: "failed", reason: "unavailable" });
        throw error;
      }
      const method = resolvedMethod;
      operation.session = new WizardSession(async (prompter, signal) => {
        // Constructor runners start immediately; yield until the operation owns
        // its session so synchronous provider failures can also be cancelled.
        await Promise.resolve();
        let failure: "exchange" | "unavailable" = "exchange";
        try {
          assertLive(operation);
          // Reconnect may reuse only this person's selected private registration.
          // Shared gateway profiles never enter a personal provider login context.
          const selected = await readSelectedUserModelAccount(operation.owner, provider, {
            context,
          });
          assertLive(operation);
          const result = await runProviderPluginAuthMethodUnpersisted({
            config: {},
            env: {},
            existingProfiles: selected
              ? [{ profileId: selected.id, credential: selected.credential }]
              : [],
            method,
            prompter,
            signal,
            assertCurrent: () => assertLive(operation),
            isRemote: true,
            secretInputMode: "plaintext",
            allowSecretRefPrompt: false,
            runtime: {
              log: () => {},
              error: () => {},
              exit: () => {
                throw new Error("Provider sign-in stopped.");
              },
            },
          });
          assertLive(operation);
          const profile = result.profiles[0];
          if (
            result.profiles.length !== 1 ||
            !profile ||
            profile.credential.provider !== provider ||
            profile.secretStorage
          ) {
            finish(operation, { status: "failed", reason: "identity" });
            return;
          }
          // The private store repeats this guard inside its synchronous commit.
          // Config patches, shared profile IDs, and global defaults are not applied.
          failure = "unavailable";
          operation.settlement = retainWrite(async () => {
            const connected = await connectUserModelAccount(
              {
                ownerProfileId: operation.owner,
                credential: profile.credential,
                matchesCredential: (existing) =>
                  (method.matchesPersonalAccount ?? matchesLiteralCredential)(
                    profile.credential,
                    existing,
                  ),
                authorityProfileIds: [
                  ...new Set(
                    [operation.action, operation.answerAction].flatMap((current) =>
                      current?.actorProfileId ? [current.actorProfileId] : [],
                    ),
                  ),
                ],
                assertCurrent: (roles) => assertLive(operation, roles),
              },
              { context },
            );
            finish(operation, { status: "connected", authProfileId: connected.authProfileId });
            options.onChanged?.();
          });
          await operation.settlement;
        } catch {
          snapshot(operation);
          finish(operation, { status: "failed", reason: failure });
        }
      });
      return { connectId: id, expiresAtMs: operation.expiresAtMs };
    },
    async statusAsync(
      action: ModelAccountConnectAction,
      connectId: string,
    ): Promise<UsersAuthConnectStatusResult> {
      const operation = findOperation(action, connectId);
      return operation ? projectResultAsync(action, operation) : { status: "expired" };
    },
    async answer(
      action: ModelAccountConnectAction,
      connectId: string,
      stepId: string,
      value?: unknown,
    ): Promise<UsersAuthConnectStatusResult> {
      const operation = findOperation(action, connectId);
      if (!operation) {
        return { status: "expired" };
      }
      if (snapshot(operation)) {
        return projectResultAsync(action, operation);
      }
      const step = operation.session?.getCurrentStep();
      if (!operation.session || step?.id !== stepId || step.type === "progress") {
        // A browser callback can retire the displayed prompt before its answer
        // arrives. Ignore that value without cancelling the advancing sign-in.
        const result = await projectResultAsync(action, operation);
        return result.status === "pending"
          ? { ...result, error: "This step has changed. Follow the current sign-in instructions." }
          : result;
      }
      if (step.sensitive && typeof value === "string") {
        registerSecretValueForRedaction(value);
      }
      operation.answerAction = action;
      // Bind the answerer's authority before resolving the provider's prompt;
      // its continuation may commit before this await returns.
      const error = await operation.session.answer(stepId, value);
      assertRunning(action);
      const result = await projectResultAsync(action, operation);
      if (error && result.status === "pending" && result.step?.id === stepId) {
        return {
          ...result,
          error: "That answer is not valid. Check the sign-in instructions and try again.",
        };
      }
      return result;
    },
    async cancelAsync(
      action: ModelAccountConnectAction,
      connectId: string,
    ): Promise<UsersAuthConnectStatusResult> {
      const operation = cancelOperation(action, connectId);
      return operation ? projectResultAsync(action, operation) : { status: "expired" };
    },
    supersede: (owner: string, provider: string) => supersede(owner, provider),
    async stop(): Promise<void> {
      beginClose();
      // Provider I/O may ignore cancellation; only accepted persistence retains
      // settlement ownership and must finish before the state workers close.
      await Promise.allSettled(pendingWrites);
      operations.clear();
    },
  };
}
