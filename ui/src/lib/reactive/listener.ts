type NativeEventMap<T> = (T extends Window | typeof globalThis
  ? WindowEventMap
  : T extends Document
    ? DocumentEventMap
    : T extends HTMLElement
      ? HTMLElementEventMap
      : T extends MediaQueryList
        ? MediaQueryListEventMap
        : T extends VisualViewport
          ? VisualViewportEventMap
          : T extends ServiceWorkerContainer
            ? ServiceWorkerContainerEventMap
            : T extends MessagePort
              ? MessagePortEventMap
              : T extends WebSocket
                ? WebSocketEventMap
                : T extends Worker
                  ? WorkerEventMap
                  : T extends RTCDataChannel
                    ? RTCDataChannelEventMap
                    : T extends RTCPeerConnection
                      ? RTCPeerConnectionEventMap
                      : T extends MediaStreamTrack
                        ? MediaStreamTrackEventMap
                        : T extends FileReader
                          ? FileReaderEventMap
                          : Record<string, Event>) &
  Record<string, Event>;

export function listen<T extends EventTarget, K extends string>(
  target: T,
  type: K,
  handler: ((event: NativeEventMap<T>[K]) => void) | EventListenerObject,
  options?: boolean | AddEventListenerOptions,
) {
  // SAFETY: The target's native event map supplies the callback's event type.
  const listener = handler as EventListenerOrEventListenerObject;
  target.addEventListener(type, listener, options);
  return () => target.removeEventListener(type, listener, options);
}

type Subscription = { callback: () => void };
type EventPool = { subscribers: Set<Subscription>; stop: () => void };

export function createSharedEventObserver(type: string, capture?: boolean) {
  const pools = new WeakMap<EventTarget, EventPool>();
  return (target: EventTarget, callback: () => void) => {
    let pool = pools.get(target);
    if (!pool) {
      const subscribers = new Set<Subscription>();
      pool = {
        subscribers,
        stop: listen(
          target,
          type,
          () => {
            const delivery = [...subscribers];
            for (const subscriber of delivery) {
              if (!subscribers.has(subscriber)) {
                continue;
              }
              try {
                subscriber.callback();
              } catch (error) {
                reportError(error);
              }
            }
          },
          capture,
        ),
      };
      pools.set(target, pool);
    }
    const subscription = { callback };
    pool.subscribers.add(subscription);
    return () => {
      if (!pool.subscribers.delete(subscription)) {
        return;
      }
      if (pool.subscribers.size === 0) {
        pool.stop();
        pools.delete(target);
      }
    };
  };
}
