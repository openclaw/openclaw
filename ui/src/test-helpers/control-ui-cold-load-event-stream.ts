import type { ColdLoadProbeInput } from "./control-ui-cold-load-probe-init.ts";

/** Serialized with the probe; mock event identity and scheduling stay in one owner. */
export function createColdLoadEventStream(input: ColdLoadProbeInput) {
  let progressId: string | undefined;
  let instanceId: string | undefined;
  let bootStarted = false;
  let queued = 0;
  let sentEvents = 0;
  let emitting:
    | { index: number; kind: string; event: string; plannedAtMs: number; queuedAtMs: number }
    | undefined;
  const payloadWithIdentity = (payload: unknown) =>
    JSON.parse(JSON.stringify(payload), (key, value) =>
      key === "progressId"
        ? progressId
        : key === "instanceId" && value === "team-scale-self"
          ? instanceId
          : value,
    );
  return {
    observeRequest(frame: {
      method: string;
      params?: { client?: { instanceId?: string }; progressId?: string };
    }) {
      if (frame.method === "connect") {
        instanceId = frame.params?.client?.instanceId;
      }
      if (frame.method !== "sessions.catalog.list") {
        return;
      }
      progressId = frame.params?.progressId;
      if (bootStarted) {
        return;
      }
      bootStarted = true;
      input.events.forEach((item, index) => {
        queued++;
        window.setTimeout(
          () => {
            queued--;
            Reflect.get(window, "openclawControlUiE2eGateway").emit(
              item.event,
              payloadWithIdentity(item.payload),
            );
            sentEvents++;
          },
          input.latencyMs + (index + 1) * input.frameGapMs,
        );
      });
    },
    startLive(startedAt: number) {
      const history = input.liveHistory;
      const gateway = Reflect.get(window, "openclawControlUiE2eGateway");
      if (history) {
        gateway.setRequestHandler(
          "chat.history",
          ({ respond }: { respond: (payload: unknown) => void }) =>
            respond({
              ...history,
              messages: [...history.messages],
              inFlightRun: { ...history.inFlightRun },
            }),
        );
      }
      for (const [index, item] of (input.liveEvents ?? []).entries()) {
        const emit = async () => {
          if (item.sessionMutation) {
            await Reflect.get(window, "__teamScaleSidebarLists").apply(item.sessionMutation);
          }
          emitting = {
            index: index + 1,
            kind: item.kind,
            event: item.event,
            plannedAtMs: item.atMs,
            queuedAtMs: performance.now() - startedAt,
          };
          if (history && item.history) {
            if (item.history.message !== undefined) {
              history.messages.push(item.history.message);
            }
            if (item.history.text !== undefined) {
              history.inFlightRun.text = item.history.text;
            }
          }
          gateway.emit(item.event, payloadWithIdentity(item.payload));
          emitting = undefined;
        };
        window.setTimeout(() => {
          void emit();
        }, item.atMs);
      }
    },
    get emitting() {
      return emitting;
    },
    get queued() {
      return queued;
    },
    get sentEvents() {
      return sentEvents;
    },
  };
}
