import type { SessionEntry } from "../config/sessions.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";

export { mergeImportedChatHistoryMessages };

export function augmentChatHistoryWithCliSessionImports(params: {
  entry: SessionEntry | undefined;
  provider?: string;
  localMessages: unknown[];
  homeDir?: string;
}): unknown[] {
  void params.entry;
  void params.provider;
  void params.homeDir;
  return params.localMessages;
}
