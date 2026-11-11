import type { NormalizedControlUiMockGatewayScenario } from "./control-ui-mock-scenario.ts";

// Serialized into the page with the mock Gateway; keep dependencies inside the factory.
export function createControlUiMockMethodDelays(initial: Record<string, number | "forever">) {
  const delays = { ...initial };
  const held = new Map<string, Array<() => void>>();
  return {
    schedule(method: string, dispatch: () => void) {
      const delay = delays[method];
      if (delay === "forever") {
        const pending = held.get(method) ?? [];
        pending.push(dispatch);
        held.set(method, pending);
      } else {
        window.setTimeout(dispatch, delay ?? 0);
      }
    },
    set: (method: string, delay: number | "forever" | null) => {
      if (delay === null) {
        delete delays[method];
      } else {
        delays[method] = delay;
      }
      if (delay !== "forever") {
        const pending = held.get(method) ?? [];
        held.delete(method);
        for (const dispatch of pending) {
          if (delay !== null && delay > 0) {
            window.setTimeout(dispatch, delay);
          } else {
            dispatch();
          }
        }
      }
    },
  };
}

const rosterMethods = new Set([
  "connect",
  "agents.list",
  "sessions.resolve",
  "chat.startup",
  "chat.history",
  "sessions.list",
  "sessions.messages.subscribe",
]);

export function shouldWaitForControlUiMockRoster(
  scenario: NormalizedControlUiMockGatewayScenario,
  requested: boolean | undefined,
): boolean {
  const connectResponse = scenario.methodResponses.connect;
  const connectFails =
    connectResponse !== null &&
    typeof connectResponse === "object" &&
    "__mockError" in connectResponse;
  return (
    requested ??
    (!connectFails &&
      scenario.startupPendingResponses === 0 &&
      ![
        ...scenario.heldMethods,
        ...scenario.deferredMethods,
        ...scenario.heldRequests.map((request) => request.method),
        ...scenario.deferredRequests.map((request) => request.method),
        ...Object.keys(scenario.methodDelays).filter(
          (method) => scenario.methodDelays[method] === "forever",
        ),
      ].some((method) => rosterMethods.has(method)))
  );
}
