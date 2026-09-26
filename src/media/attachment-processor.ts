import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import {
  prepareAttachment,
  type AttachmentInput,
  type PreparedAttachment,
} from "./attachment-processor.runtime.js";

const pool = new WorkerTaskPool<AttachmentInput, PreparedAttachment>({
  workerUrl: resolveRuntimeProcessEntrypointUrl("attachmentProcessor"),
  maxWorkers: 2,
  sharedCompute: true,
});

export async function prepareMediaAttachment(
  input: AttachmentInput,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<PreparedAttachment> {
  signal?.throwIfAborted();
  // Attachments forbid interior whitespace; oversized encoded input cannot become admissible.
  const size =
    Math.floor((input.base64.length * 3) / 4) -
    (input.base64.endsWith("==") ? 2 : input.base64.endsWith("=") ? 1 : 0);
  if (size > maxBytes) {
    throw new Error(`attachment ${input.label}: exceeds size limit (${size} > ${maxBytes} bytes)`);
  }
  const result =
    input.base64.length < 256 * 1024
      ? await prepareAttachment(input)
      : await pool.run(input, { inputBytes: input.base64.length * 2, signal, timeoutMs: 180_000 });
  signal?.throwIfAborted();
  return result;
}
