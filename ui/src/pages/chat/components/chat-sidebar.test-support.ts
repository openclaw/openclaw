import type { ApplicationContext } from "../../../app/context.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../../test-helpers/application-context.ts";

export function createChatSidebarContainer() {
  // SAFETY: Disconnected file-preview fixtures only use Gateway and agent selection; discovery is unavailable.
  return createApplicationContextProvider({
    gateway: createApplicationGateway().gateway,
    agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
  } as ApplicationContext);
}
