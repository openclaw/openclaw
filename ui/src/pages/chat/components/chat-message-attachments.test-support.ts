import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import { createAssistantAudioMessage, type TestMessage } from "./chat-message.test-support.ts";

export function requireFetchCallForUrl(fetchMock: ReturnType<typeof vi.fn>, expectedUrl: string) {
  const call = fetchMock.mock.calls.find(([url]) => url === expectedUrl) as
    | [string, RequestInit?]
    | undefined;
  return expectDefined(call, `fetch call for ${expectedUrl}`);
}

export function expectSameOriginGet(init: RequestInit | undefined) {
  expect(init).toMatchObject({ credentials: "same-origin", method: "GET" });
}

export function rejectWhenAborted<T>(signal: AbortSignal, rejection: () => Error): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(rejection()), { once: true });
  });
}

export async function flushAttachmentChecks() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

export async function advanceAttachments(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await flushAttachmentChecks();
}

export function stubFetch<T extends NonNullable<Parameters<typeof vi.fn>[0]>>(implementation?: T) {
  const mock = vi.fn(implementation);
  vi.stubGlobal("fetch", mock);
  return mock;
}

export function nativeAudio(
  source: string,
  artifactId: string,
  overrides: TestMessage = {},
  message: TestMessage = {},
) {
  return createAssistantAudioMessage(
    source,
    {
      artifactId,
      fileName: "voice.mp3",
      mimeType: "audio/mpeg",
      playback: "native",
      ...overrides,
    },
    message,
  );
}

export function attachmentDownload(container: Element) {
  return container.querySelector<HTMLAnchorElement>(".chat-assistant-attachment-card__download");
}

export function stubObjectUrls(create: () => string) {
  const createObjectURL = vi.fn(create);
  const revokeObjectURL = vi.fn();
  const NativeUrl = URL;
  vi.stubGlobal(
    "URL",
    class extends NativeUrl {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  return { createObjectURL, revokeObjectURL };
}
