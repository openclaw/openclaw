import {
  assertDeferredDisplayPayload,
  type DeferredDisplayPayload,
} from "./deferred-visibility.js";

export type RenderableDeferredDisplayPayload = DeferredDisplayPayload;

export function renderDeferredBatch(params: {
  title: string;
  items: RenderableDeferredDisplayPayload[];
  summary?: string;
}): string {
  const blocks: string[] = [params.title];
  if (params.summary?.trim()) {
    blocks.push(params.summary.trim());
  }
  params.items.forEach((item, idx) => {
    const payload = assertDeferredDisplayPayload(item, `renderable deferred item #${idx + 1}`);
    const content = payload.text?.trim() || payload.summaryLine?.trim();
    blocks.push(`---\nQueued #${idx + 1}\n${content}`.trim());
  });
  return blocks.join("\n\n");
}
