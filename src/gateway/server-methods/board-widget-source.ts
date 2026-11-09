import {
  type BoardWidgetSourceResult,
  validateBoardWidgetSourceParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { BoardValidationError } from "../../boards/board-layout.js";
import type { BoardStore } from "../../boards/board-store.js";
import { captureBoardRequestAuthority } from "../board-host-tools.js";
import { sessionObserverScopeKey } from "../session-observer-model.js";
import { defineBoardMethod, resolveBoardSession } from "./board-handler-context.js";

export function createBoardWidgetSourceHandler(store: BoardStore) {
  return defineBoardMethod(
    "board.widget.source",
    validateBoardWidgetSourceParams,
    async (invocation) => {
      const { params, respond, context } = invocation;
      const authority = captureBoardRequestAuthority(invocation);
      const target = resolveBoardSession(params, context, respond, "read");
      if (!target) {
        return;
      }
      const offset = params.offset ?? 0;
      if (offset > 0 && params.expectedRevision === undefined) {
        throw new BoardValidationError(
          "invalid_operation",
          "expectedRevision is required after the first source page",
        );
      }
      const source = await store.useWidgetDocument(
        target,
        params.name,
        (document): BoardWidgetSourceResult => {
          authority.assertActive();
          if (!document || !("html" in document)) {
            throw new BoardValidationError(
              "invalid_operation",
              "HTML widget not found in this dashboard",
            );
          }
          if (
            params.expectedRevision !== undefined &&
            document.revision !== params.expectedRevision
          ) {
            throw new BoardValidationError(
              "invalid_operation",
              "Widget revision changed; read its source again from the start",
            );
          }
          const html = document.html;
          if (
            offset > html.length ||
            (offset > 0 &&
              /[\uDC00-\uDFFF]/u.test(html[offset] ?? "") &&
              /[\uD800-\uDBFF]/u.test(html[offset - 1] ?? ""))
          ) {
            throw new BoardValidationError(
              "invalid_operation",
              "Source offset is outside a Unicode character boundary",
            );
          }
          let end = Math.min(html.length, offset + (params.limit ?? 32_768));
          // Do not split a surrogate pair between source pages.
          if (
            end < html.length &&
            /[\uD800-\uDBFF]/u.test(html[end - 1] ?? "") &&
            /[\uDC00-\uDFFF]/u.test(html[end] ?? "")
          ) {
            end += 1;
          }
          return {
            sessionKey: sessionObserverScopeKey(target.sessionKey, target.agentId),
            name: params.name,
            revision: document.revision,
            sha256: document.sha256,
            html: html.slice(offset, end),
            offset,
            totalLength: html.length,
            ...(end < html.length ? { nextOffset: end } : {}),
          };
        },
      );
      authority.assertActive();
      respond(true, source);
    },
  );
}
