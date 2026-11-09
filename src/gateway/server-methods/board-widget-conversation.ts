import { validateBoardWidgetConversationParams } from "../../../packages/gateway-protocol/src/index.js";
import { BoardValidationError } from "../../boards/board-layout.js";
import type { BoardStore } from "../../boards/board-store.js";
import { componentConversationKey } from "../../boards/component-conversation.js";
import { captureBoardRequestAuthority } from "../board-host-tools.js";
import {
  broadcastBoardChanged,
  defineBoardMethod,
  resolveBoardSession,
} from "./board-handler-context.js";

export function createBoardWidgetConversationHandler(store: BoardStore) {
  return defineBoardMethod(
    "board.widget.conversation",
    validateBoardWidgetConversationParams,
    async (invocation) => {
      const { params, context, respond } = invocation;
      const authority = captureBoardRequestAuthority(invocation);
      const target = resolveBoardSession(params, context, respond);
      if (!target) {
        return;
      }
      // Validate the route before reserving metadata; opening never starts an agent turn.
      componentConversationKey(target.sessionKey, { name: params.name, id: "0".repeat(32) });
      const snapshot = await store.getSnapshot(target);
      const current = snapshot.widgets.find((widget) => widget.name === params.name);
      authority.assertActive();
      if (!current || current.instanceId !== params.instanceId) {
        throw new BoardValidationError("not_found", "Component changed; reopen it from the Lobby.");
      }
      const identity = current.componentId
        ? { id: current.componentId, title: current.title ?? current.name }
        : await store.ensureComponentIdentity(target, params.name, params.instanceId, {
            assertCurrent: authority.assertActive,
          });
      authority.assertActive();
      if (!current.componentId) {
        broadcastBoardChanged(context, target, snapshot, params.name);
      }
      respond(true, {
        key: componentConversationKey(target.sessionKey, { name: params.name, id: identity.id }),
        title: identity.title,
      });
    },
  );
}
