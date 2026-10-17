import { resolveSafeTimeoutDelayMs } from "@openclaw/gateway-client/browser";
import type { UsersGitHubAuthorizePollResult } from "../../../../packages/gateway-protocol/src/schema/users.ts";
import type {
  ToolsGitHubAuthorizePollResult,
  ToolsGitHubAuthorizeStartResult,
} from "../../api/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  cancelAuthorizationRequest,
  githubAuthorizationMethod,
  type AuthorizationOperation,
  type GitHubAuthorizationState,
  type GitHubIdentityDependencies,
  type RequestOwner,
} from "./github-identity-shared.ts";

type AuthorizationPollResult = ToolsGitHubAuthorizePollResult | UsersGitHubAuthorizePollResult;
type AuthorizationDependencies = GitHubIdentityDependencies & {
  publish: () => void;
  isCurrent: (owner: RequestOwner) => boolean;
  begin: (owner: RequestOwner) => void;
  finish: (owner: RequestOwner, succeeded: boolean) => void;
  applySuccess: (
    owner: RequestOwner,
    result: Extract<AuthorizationPollResult, { status: "success" }>,
    refreshError: string | null,
  ) => void;
};

// The device flow owns timers and cancellation; callers own connection/access fences
// and the distinct personal-credential or shared-configuration mutation boundary.
export function createGitHubDeviceAuthorization(deps: AuthorizationDependencies) {
  let state: GitHubAuthorizationState = { phase: "idle" };
  let activeOperation: AuthorizationOperation | null = null;

  function isCurrent(operation: AuthorizationOperation) {
    return activeOperation === operation && deps.isCurrent(operation.owner);
  }

  function retire(notifyServer: boolean) {
    const operation = activeOperation;
    activeOperation = null;
    state = { phase: "idle" };
    if (!operation) {
      return;
    }
    if (operation.timer !== undefined) {
      clearTimeout(operation.timer);
    }
    operation.controller.abort();
    if (notifyServer) {
      cancelAuthorizationRequest(operation);
    }
  }

  function restore(owner: RequestOwner, pending: ToolsGitHubAuthorizeStartResult) {
    if (activeOperation !== null || !deps.isCurrent(owner)) {
      return;
    }
    const operation: AuthorizationOperation = {
      owner,
      controller: new AbortController(),
      start: pending,
      displayExpiresAtMs: Date.now() + pending.expiresInMs,
    };
    activeOperation = operation;
    present(operation, "code");
    schedule(operation, pending.pollAfterMs);
  }

  function present(
    operation: AuthorizationOperation,
    phase: "code" | "pending" | "network_error" | "cancelling" | "finishing" | "cancel_error",
    slowedDown?: boolean,
  ) {
    if (!operation.start) {
      return;
    }
    state = {
      ...operation.start,
      displayExpiresAtMs: operation.displayExpiresAtMs ?? Date.now(),
      phase,
      ...(operation.cancelError ? { message: operation.cancelError } : {}),
      ...(slowedDown ? { slowedDown: true } : {}),
    };
    deps.publish();
  }

  async function start(owner: RequestOwner) {
    const operation: AuthorizationOperation = { owner, controller: new AbortController() };
    activeOperation = operation;
    state = { phase: "starting" };
    deps.publish();
    try {
      const target = owner.target;
      const result = await owner.client.request<ToolsGitHubAuthorizeStartResult>(
        githubAuthorizationMethod(owner, "start"),
        target.kind === "personal" ? {} : { scope: target.scope, agentId: target.agentId },
        { signal: operation.controller.signal },
      );
      operation.start = result;
      operation.displayExpiresAtMs = Date.now() + result.expiresInMs;
      if (!isCurrent(operation)) {
        cancelAuthorizationRequest(operation);
        return;
      }
      if (operation.cancelRequested) {
        await finishCancellation(operation);
        return;
      }
      present(operation, "code");
      schedule(operation, result.pollAfterMs);
    } catch (error) {
      if (!isCurrent(operation)) {
        return;
      }
      activeOperation = null;
      state = { phase: "failed", message: formatUiError(error) };
      deps.publish();
    }
  }

  async function cancel() {
    const operation = activeOperation;
    if (!operation || operation.cancelRequested || operation.cancelInFlight) {
      return;
    }
    operation.cancelRequested = true;
    operation.cancelError = undefined;
    if (operation.start) {
      present(operation, "cancelling");
    } else {
      state = { phase: "cancelling" };
      deps.publish();
    }
    if (operation.start?.requestId) {
      await finishCancellation(operation);
    }
  }

  async function finishCancellation(operation: AuthorizationOperation) {
    if (!operation.start?.requestId || operation.cancelInFlight || !isCurrent(operation)) {
      return;
    }
    operation.cancelInFlight = true;
    try {
      const result = await operation.owner.client.request<{ cancelled: boolean }>(
        githubAuthorizationMethod(operation.owner, "cancel"),
        { requestId: operation.start.requestId },
      );
      if (!isCurrent(operation)) {
        return;
      }
      if (result.cancelled) {
        retire(false);
        deps.finish(operation.owner, false);
        deps.publish();
        return;
      }
      operation.cancelTooLate = true;
      present(operation, "finishing");
    } catch (error) {
      if (!isCurrent(operation)) {
        return;
      }
      operation.cancelRequested = false;
      operation.cancelError = formatUiError(error);
      present(operation, "cancel_error");
    } finally {
      operation.cancelInFlight = false;
    }
    // A cancellation made during start has no poll timer yet.
    if (operation.timer === undefined && !operation.pollInFlight) {
      schedule(operation, operation.start!.pollAfterMs);
    }
  }

  function schedule(operation: AuthorizationOperation, delayMs: number) {
    if (!isCurrent(operation) || !operation.start) {
      return;
    }
    if (operation.timer !== undefined) {
      clearTimeout(operation.timer);
    }
    operation.timer = setTimeout(
      () => {
        operation.timer = undefined;
        if (isCurrent(operation)) {
          void poll(operation);
        }
      },
      resolveSafeTimeoutDelayMs(delayMs, { minMs: 0 }),
    );
  }

  async function requestPoll(operation: AuthorizationOperation) {
    const request = () =>
      operation.owner.client.request<AuthorizationPollResult>(
        githubAuthorizationMethod(operation.owner, "poll"),
        { requestId: operation.start?.requestId },
        { signal: operation.controller.signal },
      );
    if (operation.owner.target.kind === "personal") {
      return { result: await request(), refreshError: null };
    }
    if (!deps.runExternalMutation) {
      throw new Error("Shared GitHub configuration is unavailable.");
    }
    const mutation = await deps.runExternalMutation(
      (client) => {
        if (client !== operation.owner.client) {
          throw new Error("Connection changed before GitHub authorization was checked.");
        }
        return request();
      },
      {
        canDispatch: () => isCurrent(operation),
        dispatchError: "Access changed before GitHub authorization was checked.",
        shouldRefresh: (result) => result.status === "success",
      },
    );
    if (!mutation.ok) {
      throw new Error(mutation.error);
    }
    return {
      result: mutation.value,
      refreshError: mutation.refresh.ok ? null : mutation.refresh.error,
    };
  }

  async function poll(operation: AuthorizationOperation) {
    if (!operation.start?.requestId || !isCurrent(operation)) {
      return;
    }
    present(
      operation,
      operation.cancelTooLate ? "finishing" : operation.cancelError ? "cancel_error" : "pending",
    );
    operation.pollInFlight = true;
    deps.begin(operation.owner);
    let succeeded = false;
    try {
      const { result, refreshError } = await requestPoll(operation);
      if (!isCurrent(operation)) {
        return;
      }
      if (
        result.status === "pending" ||
        result.status === "slow_down" ||
        result.status === "network_error"
      ) {
        const phase = operation.cancelTooLate
          ? "finishing"
          : operation.cancelError
            ? "cancel_error"
            : result.status === "network_error"
              ? "network_error"
              : "pending";
        present(operation, phase, result.status === "slow_down");
        schedule(operation, result.retryAfterMs);
        return;
      }
      if (result.status === "success") {
        deps.applySuccess(operation.owner, result, refreshError);
        deps.authorizationSucceeded?.();
        state = { phase: "idle" };
        succeeded = true;
      } else {
        state = { phase: result.status };
      }
      activeOperation = null;
    } catch (error) {
      if (isCurrent(operation)) {
        activeOperation = null;
        state = { phase: "failed", message: formatUiError(error) };
      }
    } finally {
      operation.pollInFlight = false;
      deps.finish(operation.owner, succeeded);
    }
  }
  return {
    state: () => state,
    active: () => activeOperation !== null,
    retire,
    restore,
    start,
    cancel,
  };
}
