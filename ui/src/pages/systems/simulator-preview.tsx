import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import type { ApplicationGatewaySnapshot } from "../../app/context-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { SimulatorInputQueue } from "./simulator-input-queue.ts";

type Client = NonNullable<ApplicationGatewaySnapshot["client"]>;
type CaptureFrame = {
  sessionId: string;
  sequence: number;
  jpegBase64?: string | null;
  width: number;
  height: number;
};

function frameFrom(value: unknown): CaptureFrame {
  const frame = asOptionalObjectRecord(value);
  if (
    typeof frame?.sessionId !== "string" ||
    typeof frame.sequence !== "number" ||
    typeof frame.width !== "number" ||
    typeof frame.height !== "number" ||
    (frame.jpegBase64 != null && typeof frame.jpegBase64 !== "string")
  ) {
    throw new Error("Simulator returned an invalid frame. Reopen the preview.");
  }
  return {
    sessionId: frame.sessionId,
    sequence: frame.sequence,
    jpegBase64: frame.jpegBase64,
    width: frame.width,
    height: frame.height,
  };
}

async function invoke(
  client: Client,
  nodeId: string,
  command: "simulator.capture" | "simulator.act",
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const result = await client.request<{ payload?: unknown }>(
    "node.invoke",
    { nodeId, command, params, idempotencyKey: crypto.randomUUID(), timeoutMs: 10_000 },
    signal ? { signal } : undefined,
  );
  return result.payload;
}

/** A single live Mac-node capture; the Gateway connection owns its control lease. */
export function SimulatorPreview(props: {
  nodeId: string;
  client: Client;
  presented: boolean;
  canControl: boolean;
}) {
  const [image, setImage] = createSignal<string | null>(null);
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [error, setError] = createSignal<string | null>(null);
  const [fps, setFps] = createSignal(0);
  const [retry, setRetry] = createSignal(0);
  const [text, setText] = createSignal("");
  const [textError, setTextError] = createSignal<string | null>(null);
  const [sendingText, setSendingText] = createSignal(false);
  let frameSession: { sessionId: string; executionId: string } | undefined;
  let gesture: { pointerId: number; fromX: number; fromY: number } | undefined;
  let active = false;
  let endCapture: (() => void) | undefined;
  let previousStop: Promise<void> = Promise.resolve();
  const inputQueue = new SimulatorInputQueue(
    () => active && props.canControl && !error(),
    (cause) => {
      if (active) {
        setError(formatUiError(cause));
        setImage(null);
        endCapture?.();
      }
    },
  );

  const sendInput = (
    action: string,
    details: Record<string, unknown> = {},
    onSuccess?: () => void,
  ) => {
    const session = frameSession;
    if (!session || !props.canControl || !active || error()) {
      return;
    }
    const client = props.client;
    const nodeId = props.nodeId;
    return inputQueue.enqueue(async () => {
      await invoke(client, nodeId, "simulator.act", {
        ...session,
        action,
        ...details,
      });
      onSuccess?.();
    });
  };

  const sendText = () => {
    const value = text();
    if (!value || !frameSession || !image() || error() || sendingText()) return;
    if (new TextEncoder().encode(value).byteLength > 4096) {
      setTextError(t("systems.simulator.textTooLong"));
      return;
    }
    setTextError(null);
    const request = sendInput("type", { text: value }, () => {
      setText((current) => (current === value ? "" : current));
    });
    if (request) {
      setSendingText(true);
      void request.finally(() => setSendingText(false));
    }
  };

  const point = (event: PointerEvent) => {
    // SAFETY: only the preview image pointer handlers call this mapper.
    const rect = (event.currentTarget as HTMLImageElement).getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };

  createEffect(
    () => props.canControl,
    (canControl) => {
      if (!canControl) {
        inputQueue.retire();
        gesture = undefined;
      }
    },
  );

  // Inventory polls recompute node props; only an authority change may restart the capture lease.
  const captureScope = createMemo(
    () => ({
      nodeId: props.nodeId,
      client: props.client,
      presented: props.presented,
      retry: retry(),
    }),
    {
      equals: (before, after) =>
        before.nodeId === after.nodeId &&
        before.client === after.client &&
        before.presented === after.presented &&
        before.retry === after.retry,
    },
  );

  createEffect(captureScope, ({ nodeId, client, presented }) => {
    if (!presented) {
      return;
    }
    const controller = new AbortController();
    const executionId = crypto.randomUUID();
    inputQueue.retire();
    active = true;
    setImage(null);
    setError(null);
    setFps(0);
    let sessionId: string | undefined;
    let startedRequest: Promise<unknown> | undefined;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      active = false;
      inputQueue.retire();
      controller.abort();
      frameSession = undefined;
      previousStop = previousStop.then(async () => {
        let startedSession = sessionId;
        if (!startedSession && startedRequest) {
          try {
            startedSession = frameFrom(await startedRequest).sessionId;
          } catch {
            return;
          }
        }
        if (startedSession) {
          await invoke(client, nodeId, "simulator.capture", {
            action: "stop",
            sessionId: startedSession,
            executionId,
          }).catch(() => undefined);
        }
      });
    };
    endCapture = end;
    void (async () => {
      try {
        await previousStop;
        if (controller.signal.aborted) return;
        startedRequest = invoke(client, nodeId, "simulator.capture", {
          action: "start",
          executionId,
        });
        const started = frameFrom(await startedRequest);
        sessionId = started.sessionId;
        if (controller.signal.aborted) {
          return;
        }
        frameSession = { sessionId, executionId };
        let sequence = 0;
        let firstFrameDeadline = Date.now() + 5_000;
        let measuredAt = Date.now();
        let frames = 0;
        while (!controller.signal.aborted) {
          const frame = frameFrom(
            await invoke(
              client,
              nodeId,
              "simulator.capture",
              { action: "read", sessionId, executionId, after: sequence },
              controller.signal,
            ),
          );
          if (frame.jpegBase64 && frame.sequence > sequence) {
            sequence = frame.sequence;
            setSize({ width: frame.width, height: frame.height });
            setImage(`data:image/jpeg;base64,${frame.jpegBase64}`);
            frames += 1;
            const now = Date.now();
            if (now - measuredAt >= 2_000) {
              setFps((frames * 1_000) / (now - measuredAt));
              measuredAt = now;
              frames = 0;
            }
            firstFrameDeadline = Number.POSITIVE_INFINITY;
          } else if (Date.now() >= firstFrameDeadline) {
            throw new Error(
              "Simulator produced no device frames. Check that an iOS Simulator is booted and reopen the preview.",
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 75));
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(formatUiError(cause));
          setImage(null);
          end();
        }
      }
    })();
    return () => {
      end();
      if (endCapture === end) endCapture = undefined;
      gesture = undefined;
    };
  });

  return (
    <section class="simulator-preview" aria-label={t("systems.simulator.title")}>
      <header class="simulator-preview__header">
        <strong>{t("systems.simulator.title")}</strong>
        <span role="status">
          {error() ??
            (image()
              ? t("systems.simulator.live", { fps: fps().toFixed(1) })
              : t("systems.simulator.connecting"))}
        </span>
        <Show when={error()}>
          <button class="systems-text-button" onClick={() => setRetry((value) => value + 1)}>
            {t("systems.simulator.retry")}
          </button>
        </Show>
      </header>
      <div class="simulator-preview__stage">
        <Show
          when={!error() && image()}
          fallback={<p>{error() ?? t("systems.simulator.waiting")}</p>}
        >
          {(source) => (
            <img
              src={source()}
              width={size().width}
              height={size().height}
              alt={t("systems.simulator.title")}
              tabindex={props.canControl && !error() ? 0 : -1}
              class={props.canControl && !error() ? "simulator-preview__interactive" : undefined}
              onPointerDown={(event) => {
                if (!props.canControl || event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                const from = point(event);
                gesture = { pointerId: event.pointerId, fromX: from.x, fromY: from.y };
              }}
              onPointerUp={(event) => {
                const from = gesture;
                if (!from || from.pointerId !== event.pointerId) return;
                gesture = undefined;
                const to = point(event);
                if (Math.hypot(to.x - from.fromX, to.y - from.fromY) < 0.01) {
                  sendInput("left_click", to);
                } else {
                  sendInput("left_click_drag", { fromX: from.fromX, fromY: from.fromY, ...to });
                }
              }}
              onPointerCancel={(event) => {
                if (gesture?.pointerId === event.pointerId) gesture = undefined;
              }}
              onKeyDown={(event) => {
                if (!props.canControl || event.metaKey || event.ctrlKey || event.altKey) return;
                const keys: Record<string, string> = {
                  Enter: "RETURN",
                  Backspace: "BACKSPACE",
                  Tab: "TAB",
                  Escape: "ESCAPE",
                  ArrowUp: "UP",
                  ArrowDown: "DOWN",
                  ArrowLeft: "LEFT",
                  ArrowRight: "RIGHT",
                };
                if (event.key.length === 1) {
                  event.preventDefault();
                  sendInput("type", { text: event.key });
                } else if (keys[event.key]) {
                  event.preventDefault();
                  sendInput("key", { keys: keys[event.key] });
                }
              }}
            />
          )}
        </Show>
      </div>
      <footer class="simulator-preview__footer">
        <span>
          {t(
            error()
              ? "systems.simulator.disconnected"
              : image() && props.canControl
                ? "systems.simulator.controlActive"
                : "systems.simulator.viewOnly",
          )}
        </span>
        <Show when={image() && props.canControl && !error()}>
          <button
            type="button"
            class="systems-text-button"
            onClick={() => sendInput("key", { keys: "HOME" })}
          >
            {t("systems.simulator.home")}
          </button>
        </Show>
        <Show when={image() && props.canControl && !error()}>
          <form
            class="simulator-preview__text"
            onSubmit={(event) => {
              event.preventDefault();
              sendText();
            }}
          >
            <input
              aria-label={t("systems.simulator.textLabel")}
              placeholder={t("systems.simulator.textLabel")}
              value={text()}
              onInput={(event) => {
                setText(event.currentTarget.value);
                setTextError(null);
              }}
            />
            <button type="submit" disabled={!text() || sendingText()}>
              {t("systems.simulator.sendText")}
            </button>
          </form>
        </Show>
        <Show when={textError()}>{(message) => <span role="alert">{message()}</span>}</Show>
      </footer>
    </section>
  );
}
