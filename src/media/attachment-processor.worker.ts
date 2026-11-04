import { serveWorkerTasks } from "../infra/worker-task-server.js";
import {
  prepareAttachment,
  type AttachmentInput,
  type PreparedAttachment,
} from "./attachment-processor.runtime.js";

serveWorkerTasks<PreparedAttachment>(
  // SAFETY: The private pool is the only sender and owns the request shape.
  (input) => prepareAttachment(input as AttachmentInput),
  { transferList: (reply) => (reply.buffer ? [reply.buffer.buffer] : []) },
);
