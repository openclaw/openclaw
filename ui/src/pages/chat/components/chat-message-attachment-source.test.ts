/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { resolveAttachmentSource } from "./chat-message-attachment-source.ts";
import { releaseChatMediaResourceSubscriber, type AttachmentItem } from "./chat-message-media.ts";

const subscribers: (() => void)[] = [];
afterEach(() => {
  subscribers.splice(0).forEach(releaseChatMediaResourceSubscriber);
  vi.useRealTimers();
});

it("shares a managed artifact read across URL aliases without sharing other targets", async () => {
  vi.useFakeTimers();
  const response = Promise.withResolvers<{ url: string; expiresAt: string }>();
  const resolveArtifactDownload = vi.fn(() => response.promise);
  const source = (sessionKey: string, alias: string, artifactId = "shared-artifact") => {
    const subscriber = vi.fn();
    subscribers.push(subscriber);
    const attachment: AttachmentItem["attachment"] = {
      kind: "audio",
      label: "Recording",
      mimeType: "audio/mpeg",
      artifactId,
      url: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/recording/full?mediaTicket=${alias}`,
    };
    return (connectionEpoch = 1) =>
      resolveAttachmentSource(attachment, {
        connectionEpoch,
        onRequestUpdate: subscriber,
        resolveArtifactDownload,
      });
  };
  const first = source("agent:main:one", "first");
  const second = source("agent:main:one", "second");
  expect(first().status).toBe("checking");
  expect(second().status).toBe("checking");
  await Promise.resolve();
  expect(resolveArtifactDownload).toHaveBeenCalledExactlyOnceWith({
    sessionKey: "agent:main:one",
    artifactId: "shared-artifact",
  });

  const url = "/api/chat/media/outgoing/agent%3Amain%3Aone/recording/full?mediaTicket=fresh";
  response.resolve({ url, expiresAt: "2099-01-01T00:00:00.000Z" });
  await response.promise;
  expect(first()).toMatchObject({ status: "available", source: { src: url } });
  expect(second()).toMatchObject({ status: "available", source: { src: url } });
  expect(source("agent:main:one", "third")()).toMatchObject({
    status: "available",
    source: { src: url },
  });
  expect(resolveArtifactDownload).toHaveBeenCalledOnce();

  expect(source("agent:main:two", "other-session")().status).toBe("checking");
  expect(source("agent:main:one", "other-artifact", "second-artifact")().status).toBe("checking");
  expect(first(2).status).toBe("checking");
  await Promise.resolve();
  expect(resolveArtifactDownload).toHaveBeenCalledTimes(4);
});
