import type { ControlUiSessionPullRequestSnapshot } from "@openclaw/gateway-protocol";
import { createSignal } from "solid-js";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { installRepositoryPresentation } from "../test-helpers/repository-presentation.test-support.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { SessionHovercard, type SessionHovercardInput } from "./session-hovercard-solid.tsx";

export type RepositoryHovercardInput = SessionHovercardInput & {
  pullRequests?: ControlUiSessionPullRequestSnapshot;
};
const updates = new WeakMap<HTMLElement, (input: RepositoryHovercardInput) => void>();

/** Exercise the registered accessory slot while supplying presentation facts without transport. */
export function renderRepositoryHovercard(
  input: RepositoryHovercardInput,
  container = document.createElement("div"),
) {
  const update = updates.get(container);
  if (update) {
    update(input);
  } else {
    if (!container.isConnected) {
      document.body.append(container);
    }
    let snapshot = input.pullRequests;
    const client = createTestGatewayClient(async () => ({
      revision: "synthetic",
      plugins: [],
      diagnostics: [],
    }));
    const context = createContext(createGateway(client), createSessions("main", []));
    const presentation = installRepositoryPresentation(context, () => snapshot);
    mountSolid(
      () => {
        const [current, setCurrent] = createSignal(input);
        updates.set(container, (next) => {
          snapshot = next.pullRequests;
          setCurrent(next);
          presentation.notify();
        });
        return (
          <ApplicationProvider value={presentation.context} host={container}>
            <SessionHovercard
              row={current().row}
              selfUserId={current().selfUserId}
              avatarAuth={current().avatarAuth}
              personActivity={current().personActivity}
              connected={current().connected}
              session={
                current().pullRequests
                  ? { sessionKey: "agent:main:work", agentId: "main" }
                  : undefined
              }
              progressCard={current().progressCard}
            />
          </ApplicationProvider>
        );
      },
      { container },
    );
  }
  flush();
  return container;
}
