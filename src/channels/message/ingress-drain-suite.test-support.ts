import type { ChannelIngressDispatchLifecycle } from "./ingress-drain-lifecycle.js";
import {
  createChannelIngressDrain,
  type CreateChannelIngressDrainOptions,
} from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

export function withDrainFixture<T>(
  run: (fixture: ReturnType<typeof createDrainFixture> & { stateDir: string }) => Promise<T>,
  now?: () => number,
) {
  return withTempState(async (stateDir) => {
    const fixture = createDrainFixture(stateDir, now ? { now } : undefined);
    try {
      return await run({ ...fixture, stateDir });
    } finally {
      fixture.dispose();
    }
  });
}

function createDrainFixture(
  stateDir: string,
  queueOptions?: Parameters<typeof createTestIngressQueue>[1],
) {
  const queue = createTestIngressQueue(stateDir, queueOptions);
  const dispatches: string[] = [];
  const events: Parameters<
    CreateChannelIngressDrainOptions<IngressDrainTestPayload>["dispatchClaimedEvent"]
  >[0][] = [];
  const lifecycles: ChannelIngressDispatchLifecycle[] = [];
  const byId = new Map<string, ChannelIngressDispatchLifecycle>();
  const drains: ReturnType<typeof createChannelIngressDrain>[] = [];
  return {
    queue,
    dispatches,
    events,
    lifecycles,
    byId,
    dispose: () => drains.forEach((drain) => drain.dispose()),
    enqueue: (id: string, text: string, laneKey: string, receivedAt?: number) =>
      queue.enqueue(id, { text }, { laneKey, receivedAt }),
    createDrain(
      options: Partial<CreateChannelIngressDrainOptions<IngressDrainTestPayload>> = {},
      retainOwner = false,
    ) {
      const { dispatchClaimedEvent, ...rest } = options;
      const drain = createChannelIngressDrain(
        {
          queue,
          now: queueOptions?.now,
          ...rest,
          dispatchClaimedEvent: (event, lifecycle) => {
            dispatches.push(event.id);
            events.push(event);
            lifecycles.push(lifecycle);
            byId.set(event.id, lifecycle);
            return dispatchClaimedEvent
              ? dispatchClaimedEvent(event, lifecycle)
              : lifecycle.onAdopted();
          },
        },
        retainOwner,
      );
      drains.push(drain);
      return drain;
    },
  };
}
