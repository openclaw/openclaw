import type { GatewaySessionRow } from "../../api/types.ts";
import type { HeaderMenuAction } from "./components/chat-header-session-menu.ts";

type HeaderMetadataAction = Extract<
  HeaderMenuAction,
  { kind: "toggle-unread" | "set-icon" | "set-color" | "set-communication" | "reset-appearance" }
>;

export function headerSessionMetadataPatch(
  action: HeaderMetadataAction,
  session: Pick<GatewaySessionRow, "unread">,
) {
  switch (action.kind) {
    case "toggle-unread":
      return { unread: !session.unread };
    case "set-icon":
      return { icon: action.icon };
    case "set-color":
      return { color: action.color };
    case "set-communication":
      return { communication: action.communication };
    case "reset-appearance":
      return { icon: null, color: null };
  }
  return action satisfies never;
}
