import "./chat-page.ts";
import "../../styles/chat/composer-progress.css";
import "../../styles/chat/composer-queue.css";
import "../../styles/chat/composer-status.css";
import { renderChatRoute, sessionRenderOwnerKey } from "./route-view.ts";

export const header = true;
// ChatPage's bounded inner cache owns per-session teardown. Routes share the
// outer owner while their data and URL keep changing.
export const renderOwnerKey = sessionRenderOwnerKey;
export const retainOnNavigate = true;
export const render = renderChatRoute;
