import type { TemplateResult } from "lit";
import type { ConfigPageId } from "./config-sections.ts";
import { renderMeetingCapture } from "./meeting-capture.ts";
import { renderSessionStorage } from "./session-storage.ts";
import { COMMUNICATION_SETTINGS_TARGET_IDS } from "./settings-targets.ts";
import { renderTtsVoiceLab } from "./tts-voice-lab.ts";

export function resolveCuratedConfigRenderSection(params: {
  pageId: ConfigPageId;
  activeSection: string | null;
  mutationDisabled: boolean;
  advanced: boolean;
  targetBlockId?: string;
}): ((editor: TemplateResult) => TemplateResult) | undefined {
  const { pageId, activeSection, mutationDisabled, advanced, targetBlockId } = params;
  if (pageId === "communications" && activeSection === "tts") {
    return (editor) =>
      renderTtsVoiceLab({
        mutationDisabled,
        advancedExpanded:
          advanced || targetBlockId === COMMUNICATION_SETTINGS_TARGET_IDS.ttsVoiceLab,
        editor,
      });
  }
  if (pageId === "communications" && activeSection === "transcripts") {
    return (editor) =>
      renderMeetingCapture({
        mutationDisabled,
        advancedExpanded: advanced || targetBlockId === "config-section-transcripts",
        editor,
      });
  }
  if (pageId === "ai-agents" && activeSection === "session") {
    return (editor) =>
      renderSessionStorage({
        mutationDisabled,
        advancedExpanded: advanced || targetBlockId === "config-section-session",
        editor,
      });
  }
  return undefined;
}
