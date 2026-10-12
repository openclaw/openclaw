import { serveWorkerTasks } from "../infra/worker-task-server.js";
import {
  renderPublicSessionCardPng,
  type PublicSessionCard,
} from "./control-ui-public-session-card-render.js";

serveWorkerTasks<Uint8Array<ArrayBuffer>>(
  (input) => {
    // SAFETY: The private card pool is the sole sender and owns this request shape.
    return Uint8Array.from(renderPublicSessionCardPng(input as PublicSessionCard));
  },
  { transferList: (png) => [png.buffer] },
);
