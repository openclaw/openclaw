import { createMemo } from "solid-js";
import type { MarkdownTextReferences } from "../components/markdown-render-options.ts";
import { sharedPluginsProjection } from "../lib/reactive/shared-application-projections.ts";
import type { Binding } from "./control-ui-text-references.solid.ts";

/** Activation supplies the host operation; an empty registry needs no optional resolver runtime. */
export function createTextReferenceProjection(read: () => Binding) {
  const factory = createMemo(() => {
    const runtime = read().context?.plugins;
    return (
      runtime &&
      sharedPluginsProjection(runtime).read().registrations("textReferences")[0]?.host
        .projectTextReferences
    );
  });
  const projection = createMemo(() => factory()?.(read));
  return (): MarkdownTextReferences | undefined => projection()?.();
}
