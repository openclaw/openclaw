/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { createInitializationContext } from "./chat-application-context.test-support.ts";
import { createRenderTestChatPane } from "./chat-pane.test-support.ts";

it("opens voice settings for dictation without entering chat model setup", () => {
  const navigate = vi.fn();
  const pane = createRenderTestChatPane();
  pane.initialize({ ...createInitializationContext(), navigate });
  onTestFinished(() => pane.disconnectedCallback());
  pane.render();

  const props = expectDefined(pane.chatProps, "rendered composer settings actions");
  props.onOpenDictationSettings?.();
  props.onOpenTalkSettings?.();
  props.onModelSetup?.();

  expect(navigate.mock.calls).toEqual([["talk"], ["talk"], ["model-setup"]]);
});
