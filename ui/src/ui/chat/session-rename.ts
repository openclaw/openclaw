import { t } from "../../i18n/index.ts";
import { createChatSessionsLoadOverrides, scopedAgentListParamsForSession } from "../app-chat.ts";
import type { AppViewState } from "../app-view-state.ts";
import { patchSession } from "../controllers/sessions.ts";
import { normalizeOptionalString } from "../string-coerce.ts";
import type { GatewaySessionRow } from "../types.ts";

type RenameChatSessionRow = Pick<GatewaySessionRow, "key" | "label">;

export async function promptAndRenameChatSession(
  state: AppViewState,
  row: RenameChatSessionRow,
  fallbackLabel: string,
) {
  if (!state.client || !state.connected) {
    return false;
  }
  const currentLabel = normalizeOptionalString(row.label) ?? fallbackLabel;
  const nextLabel = globalThis.prompt(t("chat.selectors.renameSessionPrompt"), currentLabel);
  if (nextLabel === null) {
    return false;
  }
  const normalizedLabel = normalizeOptionalString(nextLabel);
  await patchSession(
    state,
    row.key,
    normalizedLabel ? { label: normalizedLabel } : { label: null },
    {
      ...createChatSessionsLoadOverrides(state),
      ...scopedAgentListParamsForSession(state, row.key),
    },
  );
  return true;
}
