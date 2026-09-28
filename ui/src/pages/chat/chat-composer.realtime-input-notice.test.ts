/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { renderChatView } from "./chat-view.test-helpers.ts";

it("keeps recovered microphone input-loss guidance visible while listening", () => {
  const onDismissRealtimeTalkInputNotice = vi.fn();
  const container = renderChatView({
    realtimeTalkActive: true,
    realtimeTalkStatus: "listening",
    realtimeTalkInputNotice: "Microphone input recovered; repeat the last part",
    onDismissRealtimeTalkInputNotice,
  });

  expect(container.querySelector(".agent-chat__voice-activity")).not.toBeNull();
  const notice = container.querySelector('[role="alert"].agent-chat__talk-status');
  expect(notice?.textContent).toContain("Microphone input recovered; repeat the last part");
  expect(notice?.closest(".sr-only")).toBeNull();
  const dismiss = notice?.querySelector<HTMLButtonElement>(
    `[aria-label="${t("chat.composer.dismissVoiceInputError")}"]`,
  );
  dismiss?.click();
  expect(onDismissRealtimeTalkInputNotice).toHaveBeenCalledOnce();
});
