import { parseAgentSessionKeyParts } from "@openclaw/session-url-contract";
import {
  Errored,
  Loading,
  Show,
  createMemo,
  createSignal,
  createStore,
  isPending,
  latest,
} from "solid-js";
import type { CronStatus } from "../../../api/types.ts";
import type { MenuControls } from "../../../components/solid/menu.tsx";
import { isCronInventoryInvalidation } from "../../../lib/cron/inventory-connection.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../../lib/gateway-methods.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectSource } from "../../../lib/reactive/projection.ts";
import type {
  CiAutomationOption,
  CiAutomationOptions,
  CiAutomationTarget,
} from "../../../lib/session-pr-automation-spec.ts";
import {
  loadCiAutomationJobs,
  setCiAutomationEnabled,
  type CiAutomationJobs,
} from "../../../lib/session-pr-automation.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import {
  ChatCiAutomationError,
  ChatCiAutomationView,
  type ChatCiAutomationProps,
} from "./chat-ci-automation.tsx";
import { createCiDisclosure, type ChatCiDisclosureProps } from "./chat-ci-disclosure.ts";
import { subscribeCiGatewayUpdates } from "./chat-ci-gateway-updates.ts";

/** Cron owns durable settings and execution; this element retains only the visible projection. */
type Props = ChatCiDisclosureProps & {
  sessionId: string;
  menuPresentation?: boolean;
  controls?: MenuControls;
};
const inputHandlers = new WeakMap<HTMLElement, (key: keyof Props) => void>();

type AutomationState = {
  jobs: CiAutomationJobs;
  inventoryReady: boolean;
  pending: Partial<CiAutomationOptions>;
  schedulerEnabled: boolean | undefined;
};
type Inventory = { jobs: CiAutomationJobs; schedulerEnabled: boolean };

function createCiAutomation(props: Props, host: SolidBridgeElement<Props>) {
  const [state, setState] = createStore<AutomationState>({
    jobs: {},
    inventoryReady: false,
    pending: {},
    schedulerEnabled: undefined,
  });
  const connection = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
  const gatewayProjection = createMemo(() => {
    const source = props.gateway;
    return (
      source &&
      projectSource(source, {
        read: (gateway) => gateway.snapshot,
        subscribe: (gateway, notify) => subscribeCiGatewayUpdates(gateway, "automation", notify),
        equality: "revision",
      })
    );
  });
  let connectionRevision = -1;
  let connectionGeneration = -1;
  let authKey = "";
  let version = 0;
  let inventoryVersion = -1;
  let readController: AbortController | undefined;
  let refreshPending = true;
  let stopGateway: (() => void) | undefined;
  let stopEvents: (() => void) | undefined;
  let targetKey = "";
  let sessionKey = "";
  let sessionId = "";
  // Revision admission reads this synchronous snapshot; the store only presents it.
  let accepted: Inventory | undefined;
  const [receipt, setReceipt] = createSignal(Promise.resolve<Inventory | undefined>(undefined));
  const read = createMemo(() => receipt());
  const [presentationScope, setPresentationScope] = createSignal({});
  const completions = new Set<Promise<void>>();
  const [attempt, setAttempt] = createSignal<{ result: Promise<null> }>();
  // Synchronous admission is separate from Solid's deferred presentation writes.
  const writes = new Set<CiAutomationOption>();
  const disclosure = createCiDisclosure(host, handleVisibility, () => {
    inputHandlers.set(host, handleInputsChanged);
    bindGateway();
    syncTarget();
    return () => {
      inputHandlers.delete(host);
      stopGateway?.();
      stopEvents?.();
      version += 1;
      connection.dispose();
      readController?.abort();
    };
  });

  function bindGateway() {
    stopGateway?.();
    stopEvents?.();
    const source = host.gateway;
    reset();
    // Retire request authority on every connection transition, before subsequent events.
    stopGateway = source
      ? subscribeCiGatewayUpdates(source, "automation", () => {
          syncConnection();
          queueRefresh();
        })
      : undefined;
    stopEvents = source?.subscribeEvents((event) => {
      if (isCronInventoryInvalidation(event, source.snapshot)) {
        invalidate();
      }
    });
    syncConnection();
    queueRefresh();
  }

  function syncTarget() {
    const next = JSON.stringify([host.sessionKey, host.sessionId, automationTarget()]);
    if (targetKey === next) {
      return false;
    }
    if (
      (sessionKey && sessionKey !== host.sessionKey) ||
      (sessionId && sessionId !== host.sessionId)
    ) {
      disclosure.close();
    }
    targetKey = next;
    sessionKey = host.sessionKey;
    sessionId = host.sessionId;
    reset();
    return true;
  }

  function handleInputsChanged(key: keyof Props) {
    if (key === "gateway") {
      bindGateway();
    } else if (key === "presented" || key === "inline" || syncTarget()) {
      handleVisibility();
    }
  }
  function queueRefresh() {
    queueMicrotask(() => {
      if (refreshPending && disclosure.visible() && !readController && !writes.size) {
        load();
      }
    });
  }

  function automationTarget(source: Props = host): CiAutomationTarget | null {
    const pr = source.pullRequest;
    const agentId = parseAgentSessionKeyParts(source.sessionKey)?.agentId;
    if (!pr || !agentId || !source.sessionId.trim()) {
      return null;
    }
    return {
      sessionKey: source.sessionKey,
      sessionId: source.sessionId,
      agentId,
      owner: pr.owner.toLowerCase(),
      repo: pr.repo.toLowerCase(),
      number: pr.number,
    };
  }

  function canRead(snapshot = host.gateway?.snapshot): boolean {
    return ["cron.list", "cron.status"].every((method) =>
      canCallGatewayMethod(snapshot, method, "operator.read", {
        requireAdvertisement: false,
      }),
    );
  }

  function canManage(snapshot = host.gateway?.snapshot): boolean {
    return ["cron.add", "cron.update"].every((method) =>
      canCallGatewayMethod(snapshot, method, "operator.admin", {
        requireAdvertisement: false,
      }),
    );
  }

  function syncConnection(): void {
    const gateway = host.gateway;
    const snapshot = gateway?.snapshot ?? { client: null, phase: "stopped" as const };
    const transitioned = connection.transition(snapshot);
    const revision = gateway?.connectionRevision ?? -1;
    const generation = snapshot.client?.connectionGeneration ?? -1;
    const auth = JSON.stringify(gateway?.snapshot.hello?.auth ?? null);
    if (
      transitioned ||
      revision !== connectionRevision ||
      generation !== connectionGeneration ||
      auth !== authKey
    ) {
      connectionRevision = revision;
      connectionGeneration = generation;
      authKey = auth;
      connection.invalidate();
      reset();
    }
  }

  function cancelRead(): void {
    if (!readController) {
      return;
    }
    readController.abort();
    readController = undefined;
    void setReceipt(Promise.resolve(accepted));
    refreshPending = true;
  }

  function reset(): void {
    version += 1;
    completions.clear();
    setAttempt(undefined);
    setPresentationScope({});
    cancelRead();
    inventoryVersion = -1;
    accepted = undefined;
    writes.clear();
    setState((draft) => {
      draft.jobs = {};
      draft.inventoryReady = false;
      draft.pending = {};
      draft.schedulerEnabled = undefined;
    });
    void setReceipt(Promise.resolve(undefined));
    refreshPending = true;
  }

  function invalidate(): void {
    // One trailing authoritative read absorbs event bursts and in-flight writes.
    refreshPending = true;
    queueRefresh();
  }

  function handleVisibility(): void {
    if (!disclosure.visible()) {
      cancelRead();
    }
    invalidate();
  }

  function capture() {
    const gateway = host.gateway;
    const scope = connection.capture();
    const target = automationTarget();
    if (!gateway || !scope || !target) {
      return null;
    }
    const capturedVersion = version;
    return {
      client: scope.client,
      target,
      current: () =>
        disclosure.isConnected() &&
        capturedVersion === version &&
        gateway === host.gateway &&
        connection.isCurrent(scope),
    };
  }

  function load(): void {
    if (!disclosure.visible() || readController || writes.size) {
      return;
    }
    refreshPending = false;
    const owner = capture();
    if (!owner || !owner.current() || !canRead()) {
      queueRefresh();
      return;
    }
    const admitted = owner;
    const controller = new AbortController();
    readController = controller;
    queueRefresh();
    const current = () => owner.current() && disclosure.visible() && readController === controller;
    const result = request();
    void setReceipt(result);
    // The boundary owns the visible error; cancellation may retire its reader first.
    void result.catch(() => {});

    async function request(): Promise<Inventory | undefined> {
      try {
        const [jobs, status] = await Promise.all([
          loadCiAutomationJobs(admitted.client, admitted.target, controller.signal),
          admitted.client.request<CronStatus>("cron.status", {}, { signal: controller.signal }),
        ]);
        if (current()) {
          inventoryVersion = version;
          accepted = { jobs, schedulerEnabled: status.enabled };
          setState((draft) => {
            draft.jobs = jobs;
            draft.inventoryReady = true;
            draft.schedulerEnabled = status.enabled;
          });
          return accepted;
        }
        return undefined;
      } catch (error) {
        if (current()) {
          inventoryVersion = -1;
          setState((draft) => {
            draft.inventoryReady = false;
          });
          throw new Error(formatUiError(error, t("chat.pullRequests.automationLoadFailed")), {
            cause: error,
          });
        }
        return undefined;
      } finally {
        if (current()) {
          readController = undefined;
          queueRefresh();
        }
      }
    }
  }

  function setEnabled(option: CiAutomationOption, enabled: boolean): void {
    if (
      !disclosure.visible() ||
      inventoryVersion !== version ||
      writes.has(option) ||
      !canRead() ||
      !canManage()
    ) {
      return;
    }
    const owner = capture();
    if (!owner || !owner.current()) {
      return;
    }
    const admitted = owner;
    const currentJob = accepted?.jobs[option];
    // A pre-click inventory must never overwrite newer intent or its acknowledged revision.
    cancelRead();
    writes.add(option);
    // Same-turn actions share a transaction. Keep per-option settlement independent.
    setState((draft) => {
      draft.pending[option] = enabled;
    });
    const completion = commit();
    completions.add(completion);
    // Keep the first concurrent failure visible through the remaining sibling completions.
    const result = Promise.all(completions).then(() => null);
    setAttempt({ result });
    void result.catch(() => {});
    void completion.catch(() => {}).finally(() => completions.delete(completion));
    queueRefresh();

    async function commit() {
      try {
        const job = await setCiAutomationEnabled(
          admitted.client,
          admitted.target,
          option,
          enabled,
          currentJob,
        );
        if (!admitted.current()) {
          return;
        }
        if (accepted) {
          accepted = { ...accepted, jobs: { ...accepted.jobs, [option]: job } };
        }
        setState((draft) => {
          draft.jobs[option] = job;
        });
      } catch (error) {
        if (admitted.current()) {
          // A rejected acknowledgement may hide an accepted write. Never mutate again
          // until a complete authoritative inventory has reconciled the actual outcome.
          inventoryVersion = -1;
          setState((draft) => {
            draft.inventoryReady = false;
          });
          throw new Error(formatUiError(error, t("chat.pullRequests.automationSaveFailed")), {
            cause: error,
          });
        }
      } finally {
        if (admitted.current()) {
          writes.delete(option);
          setState((draft) => {
            delete draft.pending[option];
          });
          queueRefresh();
        }
      }
    }
  }

  type ViewProps = Omit<ChatCiAutomationProps, "loading" | "error">;
  const view = createMemo<ViewProps>(() => {
    const snapshot = gatewayProjection()?.read();
    const unavailable = !automationTarget(props)
      ? t("chat.pullRequests.automationSessionRequired")
      : !canRead(snapshot)
        ? t("chat.pullRequests.automationReadRequired")
        : !canManage(snapshot)
          ? t("chat.pullRequests.automationAdminRequired")
          : undefined;
    return {
      options: {
        autoFix: state.pending.autoFix ?? state.jobs.autoFix?.enabled === true,
        autoMerge: state.pending.autoMerge ?? state.jobs.autoMerge?.enabled === true,
        autoArchive: state.pending.autoArchive ?? state.jobs.autoArchive?.enabled === true,
      },
      pending: state.pending,
      saving: Object.keys(state.pending).length > 0,
      jobs: state.jobs,
      schedulerEnabled: state.schedulerEnabled,
      disabled: Boolean(unavailable),
      disabledReason: unavailable,
      retryDisabled: !automationTarget(props) || !canRead(snapshot),
      onChange: (option, enabled) => setEnabled(option, enabled),
      onRetry: () => {
        setAttempt(undefined);
        refreshPending = true;
        load();
      },
    };
  });
  return {
    view,
    attempt,
    read,
    scope: presentationScope,
    hasInventory: () => {
      latest(read);
      return state.inventoryReady;
    },
  };
}

export type ChatCiAutomationElement = SolidBridgeElement<Props>;

function ChatCiAutomationContent(props: Props, host: SolidBridgeElement<Props>) {
  const model = createCiAutomation(props, host);
  const content = (loading = false, error?: () => string, retry?: () => void) => (
    <ChatCiAutomationView
      {...model.view()}
      errorContent={
        <Show when={error ? undefined : model.attempt()} keyed>
          {(attempt) => {
            const outcome = createMemo(() => attempt.result, { loadingValue: undefined });
            return (
              <Errored
                fallback={(mutationError) => (
                  <ChatCiAutomationError
                    error={formatUiError(mutationError())}
                    loading={isPending(model.read)}
                    saving={model.view().saving}
                    retryDisabled={model.view().retryDisabled}
                    onRetry={model.view().onRetry}
                    controls={props.controls}
                  />
                )}
              >
                {outcome()}
              </Errored>
            );
          }}
        </Show>
      }
      loading={loading || isPending(model.read)}
      disabled={loading || Boolean(error) || model.view().disabled || !model.hasInventory()}
      error={error ? error() : null}
      onRetry={retry ?? model.view().onRetry}
      menuPresentation={props.menuPresentation}
      controls={props.controls}
    />
  );
  return (
    <Errored
      fallback={(error, reset) =>
        content(
          false,
          () => formatUiError(error()),
          () => {
            model.view().onRetry();
            reset();
          },
        )
      }
    >
      <Loading on={model.scope()} fallback={content(true)}>
        {(latest(model.read), null)}
        {content()}
      </Loading>
    </Errored>
  );
}

export const ChatCiAutomationControl = defineSolidBridge<Props>(
  "openclaw-chat-ci-automation",
  ChatCiAutomationContent,
  {
    propertyChanged: (host, key) => inputHandlers.get(host)?.(key),
    properties: {
      gateway: { default: undefined, attribute: false },
      pullRequest: { default: undefined, attribute: false },
      sessionKey: { default: "", attribute: false },
      sessionId: { default: "", attribute: false },
      presented: { default: true, type: Boolean },
      inline: { default: false, attribute: false },
      menuPresentation: { default: false, attribute: false },
      controls: { default: undefined, attribute: false },
    },
  },
);
