/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { renderChatView } from "./chat-view.test-helpers.ts";

afterEach(() => resetChatViewState());

it("keeps recovered microphone input-loss guidance visible while listening", async () => {
  const onDismissRealtimeTalkInputNotice = vi.fn();
  const container = renderChatView({
    realtimeTalkActive: true,
    realtimeTalkStatus: "listening",
    realtimeTalkInputNotice: "Microphone input recovered; repeat the last part",
    onDismissRealtimeTalkInputNotice,
  });

  expect(container.querySelector(".agent-chat__voice-activity")).not.toBeNull();
  // The notice alert loads off the boot path.
  const notice = await waitForSolid(() => {
    const loaded = container.querySelector('[role="status"].agent-chat__composer-alert');
    expect(loaded?.textContent).toContain("Microphone input recovered; repeat the last part");
    return loaded;
  });
  expect(notice?.closest(".sr-only")).toBeNull();
  const dismiss = notice?.querySelector<HTMLButtonElement>(
    `[aria-label="${t("chat.composer.dismissVoiceInputError")}"]`,
  );
  dismiss?.click();
  expect(onDismissRealtimeTalkInputNotice).toHaveBeenCalledOnce();
});
