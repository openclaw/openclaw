import {
  describeUnsupportedToolResultMedia,
  extractToolResultText,
  formatToolResultText,
  isImageWithMediaPayload,
  sortPromptCacheToolsByName,
  splitSystemPromptRelocatableBoundary,
  stripSystemPromptCacheBoundary,
} from "@openclaw/ai/internal/shared";
import {
  createEmptyTransportUsage,
  createProviderWaitObserver,
  failTransportStream,
  MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
  notifyProviderHttpResponse,
  parseTerminalToolCallArguments,
} from "@openclaw/ai/transports";
import { expect, it, vi } from "vitest";
import { buildAssistantMessage } from "../agents/stream-message-shared.js";

// mock-isolation: Primitive imports must preserve the deferred full transport host boundary.
vi.mock("../agents/ai-transport-runtime-host.js", () => {
  throw new Error("Stream primitive imports must not initialize the full transport host");
});

it("exports canonical stream primitives without initializing the full transport host", async () => {
  const shared = await import("./provider-stream-shared.js");

  expect(shared.buildAssistantMessage).toBe(buildAssistantMessage);
  expect(shared.createEmptyTransportUsage).toBe(createEmptyTransportUsage);
  expect(shared.createProviderWaitObserver).toBe(createProviderWaitObserver);
  expect(shared.describeUnsupportedToolResultMedia).toBe(describeUnsupportedToolResultMedia);
  expect(shared.extractToolResultText).toBe(extractToolResultText);
  expect(shared.failTransportStream).toBe(failTransportStream);
  expect(shared.formatToolResultText).toBe(formatToolResultText);
  expect(shared.isImageWithMediaPayload).toBe(isImageWithMediaPayload);
  expect(shared.MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE).toBe(
    MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
  );
  expect(shared.notifyProviderHttpResponse).toBe(notifyProviderHttpResponse);
  expect(shared.parseTerminalToolCallArguments).toBe(parseTerminalToolCallArguments);
  expect(shared.sortPromptCacheToolsByName).toBe(sortPromptCacheToolsByName);
  expect(shared.splitSystemPromptRelocatableBoundary).toBe(splitSystemPromptRelocatableBoundary);
  expect(shared.stripSystemPromptCacheBoundary).toBe(stripSystemPromptCacheBoundary);
});
