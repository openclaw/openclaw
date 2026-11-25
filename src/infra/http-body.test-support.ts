import type { UnderlyingSource } from "node:stream/web";

export function makeStallingStream(
  initialChunks: Uint8Array[],
  onCancel?: UnderlyingSource<Uint8Array>["cancel"],
) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of initialChunks) {
        controller.enqueue(chunk);
      }
    },
    cancel: onCancel,
  });
}
