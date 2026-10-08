import { createGitHubCiAutomationRenderer } from "@openclaw/github/control-ui-api.js";
import { t } from "../../../i18n/index.ts";
import { registerChatCiEnglish } from "../../../i18n/locales/en-chat-ci.ts";

registerChatCiEnglish();

export const renderChatCiAutomation = createGitHubCiAutomationRenderer({ t });
