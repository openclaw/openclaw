import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { OriginatingChannelType } from "../templating.js";

export function resolveOriginMessageProvider(params: {
  originatingChannel?: OriginatingChannelType;
  provider?: string;
}): string | undefined {
  return (
    normalizeOptionalString(params.originatingChannel)?.toLowerCase() ??
    normalizeOptionalString(params.provider)?.toLowerCase()
  );
}

export function resolveOriginMessageTo(params: {
  originatingTo?: string;
  to?: string;
}): string | undefined {
  return params.originatingTo ?? params.to;
}

export function resolveOriginAccountId(params: {
  originatingAccountId?: string;
  accountId?: string;
}): string | undefined {
  return params.originatingAccountId ?? params.accountId;
}
