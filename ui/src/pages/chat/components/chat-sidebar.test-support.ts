import type { ApplicationContext } from "../../../app/context.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../../test-helpers/application-context.ts";

export function createChatSidebarContainer(gateway = createApplicationGateway().gateway) {
  const context: Pick<ApplicationContext, "gateway" | "agentSelection"> = {
    gateway,
    agentSelection: {
      state: { selectedId: "main", scopeId: "main" },
      intentRevision: 0,
      set: () => {},
      setScope: () => {},
      subscribe: () => () => {},
    },
  };
  // SAFETY: Preview fixtures only use Gateway and agent selection; discovery is unavailable.
  return createApplicationContextProvider(context as ApplicationContext);
}
