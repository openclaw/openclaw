import type { InlineCommandPresentation } from "../../lib/chat/chat-types.ts";
import { readInlineToolExpansion } from "./chat-activity-segments.ts";

// Disclosure policy is available before optional row code loads. The preference
// owns live-output admission; row-local boundaries own renderer readiness.
export const inlineCommandPresentation: InlineCommandPresentation = { readInlineToolExpansion };
