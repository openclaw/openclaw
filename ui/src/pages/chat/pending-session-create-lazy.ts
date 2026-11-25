import { lazy } from "solid-js";

export const PendingSessionCreate = lazy(() => import("./pending-session-create.tsx"), {
  export: "PendingSessionCreate",
});
