import type { ProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { buildStatusMessageParts as renderStatusMessageParts } from "./status-message.js";

type StatusArgs = Parameters<typeof renderStatusMessageParts>[0];
type StatusTestArgs = Omit<StatusArgs, "config"> & { config?: StatusArgs["config"] };

/** Renderer fixtures supply explicit prepared model facts; this adapter only supplies config. */
export function buildStatusMessageParts(args: StatusTestArgs) {
  return renderStatusMessageParts({ ...args, config: args.config ?? {} });
}

export function buildStatusMessage(args: StatusTestArgs): string {
  return buildStatusMessageParts(args).text;
}

/** Literal prepared facts for rendering tests; deliberately performs no parsing or resolution. */
export function statusModelRefs(selected: ProviderModelRef, active: ProviderModelRef = selected) {
  const display = (value: ProviderModelRef) => ({
    ...value,
    label: value.provider ? `${value.provider}/${value.model}` : value.model,
  });
  return {
    selected: display(selected),
    active: display(active),
    activeDiffers: selected.provider !== active.provider || selected.model !== active.model,
  };
}
