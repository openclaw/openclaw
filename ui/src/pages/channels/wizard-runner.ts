import { raceWithTimeout } from "@openclaw/retry";
import type { WizardStartResult } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { WizardNextResult, WizardStep } from "../../api/types.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { isWizardNotFoundError } from "../../lib/gateway-errors.ts";

type WizardGatewayClient = Pick<GatewayBrowserClient, "request">;

// Keep the wire request alive behind a local ceiling: protocol-level timeouts
// discard late responses, but wizard.start carries the session id needed for cleanup.
async function requestWithTimeout<T>(
  client: WizardGatewayClient,
  method: string,
  params: unknown,
  onLateResult?: (result: T) => void,
): Promise<T> {
  let timedOut = false;
  const request = client.request<T>(method, params).then((result) => {
    if (timedOut) {
      onLateResult?.(result);
    }
    return result;
  });
  return await raceWithTimeout(request, WIZARD_STEP_TIMEOUT_MS, () => {
    timedOut = true;
    throw new Error(`wizard request timed out: ${method}`);
  });
}

function cancelRunningWizardResult(client: WizardGatewayClient, result: WizardStartResult): void {
  if (!result.sessionId || result.done) {
    return;
  }
  // A start response can outlive its owning UI generation. Release only live
  // sessions; the gateway already purges terminal results before responding.
  void client.request("wizard.cancel", { sessionId: result.sessionId }).catch(() => {});
}

export type ChannelWizardState =
  | { phase: "idle" }
  | { phase: "starting"; channel: string | null }
  | {
      phase: "step";
      channel: string | null;
      step: WizardStep;
      busy: boolean;
      validationError: string | null;
    }
  | {
      phase: "done";
      channel: string | null;
      channels: readonly string[];
      accounts: ReadonlyArray<{ channel: string; accountId: string }>;
    }
  | { phase: "error"; channel: string | null; message: string };

// Long ceiling: a single step can wrap a slow gateway-side effect such as a
// catalog plugin install; the modal stays interactive via the busy flag.
const WIZARD_STEP_TIMEOUT_MS = 120_000;

export function createChannelWizard(
  getClient: () => WizardGatewayClient | null,
  onChange: () => void,
  isKnownChannel: (value: string) => boolean,
  sessionExpiredMessage: () => string,
) {
  let currentState: ChannelWizardState = { phase: "idle" };
  let wizardSessionId: string | null = null;
  let currentChannel: string | null = null;
  let currentGeneration = 0;
  let abortController: AbortController | null = null;
  let pendingCancellation: {
    client: WizardGatewayClient;
    completion: Promise<unknown>;
  } | null = null;

  async function advance(
    generation: number,
    response?: { stepId: string; value: unknown },
  ): Promise<void> {
    const client = getClient();
    const sessionId = wizardSessionId;
    if (!client || !sessionId || currentGeneration !== generation) {
      return;
    }
    const signal = abortController?.signal;
    if (!response && !signal) {
      return;
    }
    try {
      const params = {
        sessionId,
        ...(response ? { answer: response } : {}),
      };
      const result = response
        ? await requestWithTimeout<WizardNextResult>(client, "wizard.next", params)
        : await client.request<WizardNextResult>("wizard.next", params, {
            timeoutMs: null,
            ...(signal ? { signal } : {}),
          });
      if (currentGeneration !== generation) {
        return;
      }
      applyResult(result);
    } catch (err) {
      if (currentGeneration !== generation) {
        return;
      }
      if (isWizardNotFoundError(err)) {
        wizardSessionId = null;
        abortController?.abort();
        abortController = null;
        setState({
          phase: "error",
          channel: currentChannel,
          message: sessionExpiredMessage(),
        });
        return;
      }
      setState({ phase: "error", channel: currentChannel, message: formatUiError(err) });
    }
  }

  function applyResult(result: WizardNextResult): void {
    if (!result.done && result.step) {
      const gatewayOwned = result.step.executor === "gateway";
      setState({
        phase: "step",
        channel: currentChannel,
        step: result.step,
        busy: gatewayOwned,
        validationError: result.error ? formatUiExternalText(result.error) : null,
      });
      if (gatewayOwned) {
        // Gateway-owned steps cannot consume an answer; next long-polls for
        // progress or completion while keeping this generation cancellable.
        void advance(currentGeneration);
      }
      return;
    }
    wizardSessionId = null;
    abortController = null;
    if (result.status === "done") {
      // The gateway reports what the flow actually configured; the initially
      // requested channel is only a preselection and may have been skipped.
      const channels = result.channels ?? [];
      setState({
        phase: "done",
        channel: currentChannel ?? channels[0] ?? null,
        channels,
        accounts: result.accounts ?? [],
      });
      return;
    }
    if (result.status === "cancelled") {
      currentChannel = null;
      setState({ phase: "idle" });
      return;
    }
    setState({
      phase: "error",
      channel: currentChannel,
      message: formatUiExternalText(result.error, "Wizard failed."),
    });
  }

  function setState(next: ChannelWizardState): void {
    currentState = next;
    onChange();
  }
  return {
    get state() {
      return currentState;
    },
    async start(channel: string | null): Promise<void> {
      const client = getClient();
      if (!client) {
        return;
      }
      const generation = ++currentGeneration;
      abortController?.abort();
      abortController = new AbortController();
      wizardSessionId = null;
      currentChannel = channel;
      setState({ phase: "starting", channel });
      try {
        const cancellation = pendingCancellation;
        if (cancellation?.client === client) {
          await cancellation.completion;
          if (currentGeneration !== generation) {
            return;
          }
        }
        const result = await requestWithTimeout<WizardStartResult>(
          client,
          "wizard.start",
          {
            flow: "channels",
            ...(channel ? { channel } : {}),
          },
          (lateResult) => cancelRunningWizardResult(client, lateResult),
        );
        if (currentGeneration !== generation) {
          // The modal was closed/superseded mid-start, but the gateway already
          // created a running session; cancel it or later starts get rejected.
          cancelRunningWizardResult(client, result);
          return;
        }
        wizardSessionId = result.sessionId ?? null;
        applyResult(result);
      } catch (err) {
        if (currentGeneration !== generation) {
          return;
        }
        setState({ phase: "error", channel, message: formatUiError(err) });
      }
    },
    async answer(value: unknown): Promise<void> {
      const current = currentState;
      if (!getClient() || !wizardSessionId || current.phase !== "step" || current.busy) {
        return;
      }
      const generation = currentGeneration;
      if (current.step.type === "select" && typeof value === "string" && isKnownChannel(value)) {
        currentChannel ??= value;
      }
      setState({ ...current, busy: true, validationError: null });
      await advance(generation, { stepId: current.step.id, value });
    },
    async cancel(): Promise<void> {
      const client = getClient();
      const sessionId = wizardSessionId;
      currentGeneration += 1;
      wizardSessionId = null;
      abortController?.abort();
      abortController = null;
      currentChannel = null;
      setState({ phase: "idle" });
      if (client && sessionId) {
        // Replacement starts await this settlement, so it needs the same ceiling as wizard.start.
        const completion = Promise.resolve()
          .then(() => requestWithTimeout(client, "wizard.cancel", { sessionId, closeInput: true }))
          .catch(() => {
            // Session may already be finished/purged; closing the modal wins.
          });
        pendingCancellation = { client, completion };
        await completion;
        if (pendingCancellation?.completion === completion) {
          pendingCancellation = null;
        }
      }
    },
  };
}
