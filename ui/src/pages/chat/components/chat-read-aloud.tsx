import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  action,
  createEffect,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  onSettled,
  Show,
} from "solid-js";
import type { ApplicationContext } from "../../../app/context.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { currentDisplaySpeechConfig } from "../../../lib/config/config-state-model.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../../lib/gateway-methods.ts";
import { projectGateway } from "../../../lib/reactive/application.ts";
import { useApplication, useOptionalApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { sharedRuntimeConfigProjection } from "../../../lib/reactive/shared-application-projections.ts";
import { GatewaySpeechPlayback, resolveSpeechTextLimit } from "../../../lib/speech-playback.ts";

type ReadAloudProps = { text: string; buttonRef?: (element: HTMLButtonElement) => void };

function speechAvailable(context: Pick<ApplicationContext, "gateway" | "runtimeConfig">) {
  return (
    Boolean(asOptionalRecord(currentDisplaySpeechConfig(context.runtimeConfig.state))?.tts) &&
    canCallGatewayMethod(context.gateway.snapshot, "tts.speak", "operator.write")
  );
}

export function ReadAloud(props: ReadAloudProps) {
  const context = useOptionalApplication();
  return (
    <Show when={context}>
      <ReadAloudControl text={props.text} buttonRef={(element) => props.buttonRef?.(element)} />
    </Show>
  );
}

function ReadAloudControl(props: ReadAloudProps) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const config = sharedRuntimeConfigProjection(context.runtimeConfig);
  const [activated, setActivated] = createSignal(false);
  let stopPlayback: (() => void) | undefined;
  const connection = createMemo(
    () => {
      const { snapshot, connectionRevision } = gateway.read();
      return [
        snapshot.client,
        snapshot.client?.recoveryScope,
        snapshot.client?.offlineRecoveryRetired,
        connectionRevision,
        props.text,
        snapshot.phase === "connected" &&
          snapshot.hello !== null &&
          !canCallGatewayMethod(snapshot, "tts.speak", "operator.write"),
      ] as const;
    },
    { equals: (before, after) => before.every((value, index) => value === after[index]) },
  );
  createEffect(connection, () => {
    stopPlayback?.();
    const runtime = currentDisplaySpeechConfig(context.runtimeConfig.state);
    // Missing keys identify older or unavailable bootstrap projections; null is authoritative.
    if (!runtime || !Object.hasOwn(runtime, "tts")) {
      void context.runtimeConfig.ensureDisplayLoaded().catch(() => undefined);
    }
  });
  const available = createMemo(() => {
    config.read();
    gateway.read();
    return speechAvailable(context);
  });
  return (
    // Unconfigured rows need no playback lifecycle. Once used, retain Stop through reconnects.
    <Show when={available() || activated()}>
      <ReadAloudPlayback
        text={props.text}
        buttonRef={(element) => props.buttonRef?.(element)}
        available={available()}
        onActivate={() => setActivated(true)}
        onReady={(stop) => (stopPlayback = stop)}
      />
    </Show>
  );
}

function ReadAloudPlayback(
  props: ReadAloudProps & {
    available: boolean;
    onActivate: () => void;
    onReady: (stop: (() => void) | undefined) => void;
  },
) {
  const context = useApplication();
  const playback = new GatewaySpeechPlayback();
  const [playing, setPlaying] = createOptimistic(false);
  const [attempt, setAttempt] = createSignal<{ result: Promise<void> }>();
  // Readiness never hides a usable Stop control; the optimistic flag presents playback.
  const outcome = createMemo(() => attempt()?.result.then(() => null), { loadingValue: undefined });
  let generation = 0;
  let resolving = false;
  const stop = () => {
    generation += 1;
    resolving = false;
    playback.stop();
  };
  onSettled(() => {
    props.onReady(() => {
      stop();
      setAttempt(undefined);
    });
    return () => {
      props.onReady(undefined);
      stop();
    };
  });
  const presentPlayback = action(function* (pending: Promise<void>, isCurrent: () => boolean) {
    if (!isCurrent()) {
      return;
    }
    setPlaying(true);
    yield pending;
  });
  const speak = async () => {
    if (resolving) {
      stop();
      return;
    }
    const client = context.gateway.snapshot.client;
    if (!client || !speechAvailable(context)) {
      return;
    }
    props.onActivate();
    const current = ++generation;
    const connectionGeneration = client.connectionGeneration;
    const isCurrent = () => current === generation && context.gateway.snapshot.client === client;
    resolving = true;
    // Prepare audio during the native gesture, before the presentation action begins.
    const pending = (async () => {
      try {
        await playback.speak(
          client,
          props.text,
          "tts.speak",
          () =>
            isCurrent() &&
            speechAvailable(context) &&
            client.connectionGeneration === connectionGeneration,
          resolveSpeechTextLimit(currentDisplaySpeechConfig(context.runtimeConfig.state)),
        );
      } catch (cause) {
        if (isCurrent()) {
          throw cause;
        }
      } finally {
        if (isCurrent()) {
          resolving = false;
        }
      }
    })();
    // Observe rejection even if this message retires before its error slot renders.
    void pending.catch(() => {});
    setAttempt({ result: pending });
    await Promise.resolve();
    await presentPlayback(pending, isCurrent).catch(() => {});
  };
  const label = () => t(playing() ? "chat.messages.stopReading" : "chat.messages.readAloud");
  return (
    <Show when={playing() || props.available}>
      <openclaw-tooltip>
        <span slot="content">
          <Show when={!playing()} fallback={label()}>
            <Errored fallback={(error) => formatUiError(error())}>
              {outcome()}
              {label()}
            </Errored>
          </Show>
        </span>
        <button
          ref={(element) => props.buttonRef?.(element)}
          class="chat-read-aloud-btn"
          type="button"
          aria-label={label()}
          aria-pressed={playing() ? "true" : "false"}
          onClick={() => void speak()}
        >
          <Icon name={playing() ? "square" : "volume2"} />
        </button>
        <Show when={!playing()}>
          <Errored fallback={(error) => <span role="status">{formatUiError(error())}</span>}>
            {outcome()}
          </Errored>
        </Show>
      </openclaw-tooltip>
    </Show>
  );
}
