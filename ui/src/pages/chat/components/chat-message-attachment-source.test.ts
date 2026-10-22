/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { resolveAttachmentSource, readAttachmentSource } from "./chat-message-attachment-source.ts";
import { releaseChatMediaResourceOwner, type AttachmentItem } from "./chat-message-media.ts";

const subscribers: (() => void)[] = [];
afterEach(() => {
  subscribers.splice(0).forEach(releaseChatMediaResourceOwner);
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
        onMediaChange: subscriber,
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

it("reads original bytes after authorization, enforces the byte budget, and cancels pending authorization", async () => {
  vi.useFakeTimers();
  const authorization = Promise.withResolvers<{ url: string; expiresAt: string }>();
  const attachment: AttachmentItem["attachment"] = {
    kind: "document",
    label: "report.pdf",
    mimeType: "application/pdf",
    artifactId: "read-pdf",
    url: "/api/chat/media/outgoing/agent%3Amain%3Areader/report/full?mediaTicket=old",
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("%PDF-proof"));
  vi.stubGlobal("fetch", fetcher);
  const options = { connectionEpoch: 71, resolveArtifactDownload: () => authorization.promise };
  const read = readAttachmentSource(attachment, options, new AbortController().signal, 12);
  expect(fetcher).not.toHaveBeenCalled();
  const url = "/api/chat/media/outgoing/agent%3Amain%3Areader/report/full?mediaTicket=current";
  authorization.resolve({ url, expiresAt: "2099-01-01T00:00:00.000Z" });
  expect(await read).toMatchObject({ size: 10, type: "application/pdf" });
  expect(fetcher.mock.calls[0]?.[0]).toBe(url);
  await expect(
    readAttachmentSource(attachment, options, new AbortController().signal, 9),
  ).rejects.toThrow();
  const pending = Promise.withResolvers<{ url: string; expiresAt: string }>();
  const controller = new AbortController();
  const cancelled = readAttachmentSource(
    { ...attachment, artifactId: "cancel-pdf" },
    { ...options, resolveArtifactDownload: () => pending.promise },
    controller.signal,
    12,
  );
  controller.abort();
  expect(await cancelled).toBeNull();
  pending.resolve({ url, expiresAt: "2099-01-01T00:00:00.000Z" });
  await pending.promise;
  expect(fetcher).toHaveBeenCalledTimes(2);
});
