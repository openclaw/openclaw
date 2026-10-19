import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { formatUiError } from "../../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../../lib/gateway-methods.ts";
import { projectGateway } from "../../../lib/reactive/application.ts";
import { useApplication, useOptionalApplication } from "../../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../../lib/reactive/domain-capabilities.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { GatewaySpeechPlayback, resolveSpeechTextLimit } from "../../../lib/speech-playback.ts";

type ReadAloudProps = { text: string; buttonRef?: (element: HTMLButtonElement) => void };

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
  const config = projectRuntimeConfig(context.runtimeConfig);
  const playback = new GatewaySpeechPlayback();
  const [playing, setPlaying] = createSignal(false);
  const [error, setError] = createSignal("");
  let generation = 0;
  const cancelPlayback = () => {
    generation += 1;
    playback.stop();
  };
  const stop = () => {
    cancelPlayback();
    setPlaying(false);
  };
  const playbackIdentity = createMemo(
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
  createEffect(playbackIdentity, () => {
    stop();
    setError("");
    // The config capability coalesces this with the other chat consumers.
    void context.runtimeConfig.ensureLoaded().catch(() => undefined);
  });
  onCleanup(cancelPlayback);
  const available = () => {
    const snapshot = config.read().state.configSnapshot;
    const runtime = snapshot?.runtimeConfig ?? snapshot?.config;
    return (
      Boolean(asOptionalRecord(runtime)?.tts) &&
      canCallGatewayMethod(gateway.read().snapshot, "tts.speak", "operator.write")
    );
  };
  const speak = async () => {
    if (playing()) {
      stop();
      return;
    }
    const client = context.gateway.snapshot.client;
    if (!client || !available()) {
      return;
    }
    const current = ++generation;
    const connectionGeneration = client.connectionGeneration;
    const isCurrent = () => current === generation && context.gateway.snapshot.client === client;
    setPlaying(true);
    setError("");
    try {
      const snapshot = context.runtimeConfig.state.configSnapshot;
      await playback.speak(
        client,
        props.text,
        "tts.speak",
        () => isCurrent() && available() && client.connectionGeneration === connectionGeneration,
        resolveSpeechTextLimit(snapshot?.runtimeConfig ?? snapshot?.config),
      );
    } catch (cause) {
      if (isCurrent()) {
        setError(formatUiError(cause));
      }
    } finally {
      if (isCurrent()) {
        setPlaying(false);
      }
    }
  };
  const label = () => t(playing() ? "chat.messages.stopReading" : "chat.messages.readAloud");
  return (
    <Show when={playing() || available()}>
      <openclaw-tooltip prop:content={error() || label()}>
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
        <Show when={error()}>
          <span role="status">{error()}</span>
        </Show>
      </openclaw-tooltip>
    </Show>
  );
}
