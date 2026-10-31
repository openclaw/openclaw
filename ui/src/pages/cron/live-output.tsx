import type { CronLiveOutputResult } from "@openclaw/gateway-protocol";
import { createSignal } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { applyLiveOutput, type LiveOutputView } from "../../lib/cron/live-output.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { isNearStreamEnd, useStreamAutoFollow } from "../../lib/reactive/stream-auto-follow.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import type { CronProps } from "./view-types.ts";

const LIVE_OUTPUT_POLL_MS = 2000;

/**
 * Tails the running command job's Gateway buffer. The parent mounts one instance per run
 * (keyed by job and `runningAtMs`) and unmounts it when the job stops running, so the
 * recorded run in the history list below is the only copy once the run ends.
 */
export function LiveOutput(props: { gateway: CronProps["gateway"]; jobId: string }) {
  const [view, setView] = createSignal<LiveOutputView>({ text: "", truncated: false });
  const [received, setReceived] = createSignal(false);
  const [ended, setEnded] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [paused, setPaused] = createSignal(false);
  // The cursor belongs to one Gateway; the server also rejects a cursor from another run.
  let cursor: { offset: number; runAtMs: number | undefined } | null = null;
  let inFlight = false;
  let stream: HTMLElement | undefined;

  const gateway = useGatewayPage({
    getGateway: () => props.gateway,
    onIdentityChange: () => {
      cursor = null;
      setView({ text: "", truncated: false });
      setReceived(false);
    },
  });
  const follow = useStreamAutoFollow({
    container: () => stream,
    enabled: () => true,
    identity: () => gateway.epoch,
  });

  async function poll() {
    const scope = gateway.capture();
    if (!scope || inFlight) {
      return;
    }
    inFlight = true;
    try {
      const result = await scope.client.request<CronLiveOutputResult>("cron.liveOutput", {
        id: props.jobId,
        ...(cursor ? { cursor: cursor.offset, runAtMs: cursor.runAtMs } : {}),
      });
      if (!gateway.isCurrent(scope)) {
        return;
      }
      setError(null);
      if (!result.active) {
        // No buffer yet can mean the command has not started (a slow trigger); only a buffer that
        // vanished after we saw it is the end. The parent unmounts us when the run stops.
        if (cursor) {
          setEnded(true);
        }
        return;
      }
      cursor = { offset: result.cursor, runAtMs: result.runAtMs };
      if (result.text || result.reset) {
        setView(applyLiveOutput(view(), result));
        setReceived(true);
        follow.schedule(result.reset === true);
      }
    } catch (cause) {
      if (gateway.isCurrent(scope)) {
        setError(formatUiError(cause, t("cron.liveOutput.unavailable")));
      }
    } finally {
      inFlight = false;
    }
  }

  // Polls only while the tab is visible and catches up from the cursor on return.
  useVisiblePoll(LIVE_OUTPUT_POLL_MS, () => void poll(), {
    enabled: () => gateway.connected && !ended(),
    immediate: true,
  });

  return (
    <section class="cron-live-output" data-test-id="cron-live-output">
      <div class="cron-live-output__header">
        <div class="settings-row__title">{t("cron.liveOutput.title")}</div>
        <div class="settings-row__desc">{t("cron.liveOutput.hint")}</div>
      </div>
      {view().truncated ? <div class="muted">{t("cron.liveOutput.truncated")}</div> : undefined}
      {error() ? <div class="muted">{error()}</div> : undefined}
      {ended() ? <div class="muted">{t("cron.liveOutput.ended")}</div> : undefined}
      <div class="cron-live-output__frame">
        <pre
          class="code-block cron-live-output__stream"
          role="log"
          aria-live="off"
          tabindex="0"
          aria-label={t("cron.liveOutput.streamLabel")}
          ref={(element) => {
            stream = element;
          }}
          onScroll={(event) => {
            follow.handleScroll(event);
            setPaused(!isNearStreamEnd(event.currentTarget));
          }}
        >
          {received() ? view().text : t("cron.liveOutput.waiting")}
        </pre>
        {paused() ? (
          <button
            type="button"
            class="btn btn--sm cron-live-output__jump"
            onClick={() => follow.schedule(true)}
          >
            <Icon name="arrowDown" /> {t("cron.liveOutput.jumpToLatest")}
          </button>
        ) : undefined}
      </div>
    </section>
  );
}
