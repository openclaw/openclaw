import { parseAgentSessionKeyParts } from "@openclaw/session-url-contract";
import { createEffect, createMemo, createStore } from "solid-js";
import type { CronStatus } from "../../../api/types.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../../lib/gateway-methods.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
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
import { ChatCiAutomationView, type ChatCiAutomationProps } from "./chat-ci-automation.tsx";
import { createCiDisclosure, type ChatCiDisclosureProps } from "./chat-ci-disclosure.ts";

/** Cron owns durable settings and execution; this element retains only the visible projection. */
type Props = ChatCiDisclosureProps & { sessionId: string };

type AutomationState = {
  jobs: CiAutomationJobs;
  pending: Partial<CiAutomationOptions>;
  loading: boolean;
  loaded: boolean;
  schedulerEnabled: boolean | undefined;
  error: string | null;
};

function createCiAutomation(props: Props, host: SolidBridgeElement<Props>) {
  const [state, setState] = createStore<AutomationState>({
    jobs: {},
    pending: {},
    loading: false,
    loaded: false,
    schedulerEnabled: undefined,
    error: null,
  });
  const saving = createMemo(() => Object.keys(state.pending).length > 0);
  const connection = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
  const gatewayProjection = createMemo(() => {
    const source = props.gateway;
    return source && projectOwner(source, (gateway) => gateway.snapshot);
  });
  let connectionRevision = -1;
  let connectionGeneration = -1;
  let authKey = "";
  let version = 0;
  let inventoryVersion = -1;
  let readController: AbortController | undefined;
  let refreshPending = true;
  // Synchronous admission is separate from Solid's deferred presentation writes.
  const writes = new Set<CiAutomationOption>();
  const disclosure = createCiDisclosure(host, handleVisibility, () => {
    version += 1;
    connection.dispose();
    readController?.abort();
  });

  // Bind Gateway inventory and invalidation subscriptions to the current connection.
  createEffect(
    () => props.gateway,
    (source) => {
      reset();
      // Retire request authority on every connection transition, before subsequent events.
      const stopGateway = source?.subscribe(() => {
        syncConnection();
        queueRefresh();
      });
      const stopEvents = source?.subscribeEvents((event) => {
        if (event.event === "cron" || event.event === "config.changed") {
          invalidate();
        }
      });
      syncConnection();
      queueRefresh();
      return () => {
        stopGateway?.();
        stopEvents?.();
      };
    },
  );
  const targetKey = createMemo(() =>
    JSON.stringify([props.sessionKey, props.sessionId, automationTarget(props)]),
  );
  // Reset and suspend Gateway work when its session target or disclosure changes.
  createEffect(
    () => [targetKey(), props.presented, props.sessionKey, props.sessionId] as const,
    ([target, , sessionKey, sessionId], previous) => {
      if (previous?.[0] !== target) {
        if (
          previous &&
          ((previous[2] && previous[2] !== sessionKey) ||
            (previous[3] && previous[3] !== sessionId))
        ) {
          disclosure.close();
        }
        reset();
      }
      handleVisibility();
    },
  );
  function queueRefresh() {
    queueMicrotask(() => {
      if (refreshPending && disclosure.visible() && !readController && !writes.size) {
        void load();
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
    setState((draft) => {
      draft.loading = false;
    });
    refreshPending = true;
  }

  function reset(): void {
    version += 1;
    cancelRead();
    inventoryVersion = -1;
    writes.clear();
    setState((draft) => {
      draft.jobs = {};
      draft.loaded = false;
      draft.pending = {};
      draft.schedulerEnabled = undefined;
      draft.error = null;
    });
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

  async function load(): Promise<void> {
    if (!disclosure.visible() || readController || writes.size) {
      return;
    }
    refreshPending = false;
    const owner = capture();
    if (!owner || !owner.current() || !canRead()) {
      queueRefresh();
      return;
    }
    const controller = new AbortController();
    readController = controller;
    setState((draft) => {
      draft.loading = true;
    });
    queueRefresh();
    const current = () => owner.current() && disclosure.visible() && readController === controller;
    try {
      const [jobs, status] = await Promise.all([
        loadCiAutomationJobs(owner.client, owner.target, controller.signal),
        owner.client.request<CronStatus>("cron.status", {}, { signal: controller.signal }),
      ]);
      if (current()) {
        inventoryVersion = version;
        setState((draft) => {
          draft.jobs = jobs;
          draft.schedulerEnabled = status.enabled;
          draft.loaded = true;
        });
      }
    } catch (error) {
      if (current()) {
        inventoryVersion = -1;
        setState((draft) => {
          draft.loaded = false;
          draft.error = formatUiError(error, t("chat.pullRequests.automationLoadFailed"));
        });
      }
    } finally {
      if (current()) {
        setState((draft) => {
          draft.loading = false;
        });
        readController = undefined;
        queueRefresh();
      }
    }
  }

  async function setEnabled(option: CiAutomationOption, enabled: boolean): Promise<void> {
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
    // A pre-click inventory must never overwrite newer intent or its acknowledged revision.
    cancelRead();
    writes.add(option);
    setState((draft) => {
      draft.pending[option] = enabled;
      draft.error = null;
    });
    queueRefresh();
    try {
      const job = await setCiAutomationEnabled(
        owner.client,
        owner.target,
        option,
        enabled,
        state.jobs[option],
      );
      if (!owner.current()) {
        return;
      }
      setState((draft) => {
        draft.jobs[option] = job;
      });
    } catch (error) {
      if (owner.current()) {
        // A rejected acknowledgement may hide an accepted write. Never mutate again
        // until a complete authoritative inventory has reconciled the actual outcome.
        inventoryVersion = -1;
        setState((draft) => {
          draft.loaded = false;
          draft.error = formatUiError(error, t("chat.pullRequests.automationSaveFailed"));
        });
      }
    } finally {
      if (owner.current()) {
        writes.delete(option);
        setState((draft) => {
          delete draft.pending[option];
        });
        queueRefresh();
      }
    }
  }

  const view = createMemo<ChatCiAutomationProps>(() => {
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
      jobs: state.jobs,
      pending: state.pending,
      schedulerEnabled: state.schedulerEnabled,
      loading: state.loading,
      saving: saving(),
      error: state.error,
      disabled: Boolean(unavailable) || !state.loaded,
      disabledReason: unavailable,
      retryDisabled: !automationTarget(props) || !canRead(snapshot),
      onChange: (option, enabled) => void setEnabled(option, enabled),
      onRetry: () => {
        setState((draft) => {
          draft.error = null;
        });
        invalidate();
      },
    };
  });
  return view;
}

export type ChatCiAutomationElement = SolidBridgeElement<Props>;

function ChatCiAutomationContent(props: Props, host: SolidBridgeElement<Props>) {
  const read = createCiAutomation(props, host);
  return <ChatCiAutomationView {...read()} />;
}

defineSolidBridge<Props>("openclaw-chat-ci-automation", ChatCiAutomationContent, {
  properties: {
    gateway: { default: undefined, attribute: false },
    pullRequest: { default: undefined, attribute: false },
    sessionKey: { default: "", attribute: false },
    sessionId: { default: "", attribute: false },
    presented: { default: true, type: Boolean },
  },
});
