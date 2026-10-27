import "../../styles/chat/composer-progress.css";
import "../../styles/chat/composer-queue.css";
import "../../styles/chat/composer-status.css";
import { sessionRenderOwnerKey } from "./route-view.tsx";

// ChatPage's bounded inner cache owns per-session teardown. Routes share the
// outer owner while their data and URL keep changing.
export const renderOwnerKey = sessionRenderOwnerKey;
export const retainOnNavigate = true;
export { ChatRouteView as renderSolid } from "./route-view.tsx";
