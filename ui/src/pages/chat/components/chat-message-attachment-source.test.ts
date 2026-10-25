/* @vitest-environment jsdom */
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  admitManagedAttachmentGrant,
  prepareManagedAttachmentGrant,
  resolveAttachmentSource,
  readAttachmentSource,
} from "./chat-message-attachment-source.ts";
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

function preparedFixture(id: string) {
  vi.useFakeTimers();
  const sessionKey = "agent:main:prepared";
  const attachment: AttachmentItem["attachment"] = {
    kind: "audio",
    label: "Prepared recording",
    mimeType: "audio/wav",
    artifactId: id,
    url: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${id}/full?mediaTicket=prepared`,
  };
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  const controller = new AbortController();
  const receipt = prepareManagedAttachmentGrant(
    { sessionKey, artifactId: id, connectionEpoch: 31 },
    controller.signal,
  );
  onTestFinished(receipt.release);
  const subscriber = vi.fn();
  subscribers.push(subscriber);
  const resolveArtifactDownload = vi.fn(async () => ({
    url: attachment.url.replace("mediaTicket=prepared", "mediaTicket=renewed"),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  }));
  const options = { connectionEpoch: 31, onMediaChange: subscriber, resolveArtifactDownload };
  return {
    attachment,
    expiresAt,
    controller,
    receipt,
    subscriber,
    resolveArtifactDownload,
    options,
  };
}

it("adopts a prepared grant without another request, then renews it at expiry", async () => {
  const fixture = preparedFixture("prepared-renewal");
  admitManagedAttachmentGrant(fixture.receipt, fixture.attachment, fixture.expiresAt);
  fixture.receipt.release();
  expect(resolveAttachmentSource(fixture.attachment, fixture.options)).toMatchObject({
    status: "available",
    source: { src: fixture.attachment.url },
  });
  expect(fixture.resolveArtifactDownload).not.toHaveBeenCalled();
  vi.setSystemTime(Date.parse(fixture.expiresAt) + 1);
  expect(resolveAttachmentSource(fixture.attachment, fixture.options).status).toBe("checking");
  await Promise.resolve();
  await fixture.resolveArtifactDownload.mock.results[0]?.value;
  expect(resolveAttachmentSource(fixture.attachment, fixture.options)).toMatchObject({
    status: "available",
    source: { src: fixture.attachment.url.replace("mediaTicket=prepared", "mediaTicket=renewed") },
  });
  expect(fixture.resolveArtifactDownload).toHaveBeenCalledOnce();
});

it("keeps a prepared grant isolated from a replacement connection", async () => {
  const fixture = preparedFixture("prepared-reconnect");
  admitManagedAttachmentGrant(fixture.receipt, fixture.attachment, fixture.expiresAt);
  fixture.receipt.release();
  expect(
    resolveAttachmentSource(fixture.attachment, { ...fixture.options, connectionEpoch: 32 }).status,
  ).toBe("checking");
  await Promise.resolve();
  await fixture.resolveArtifactDownload.mock.results[0]?.value;
  expect(fixture.resolveArtifactDownload).toHaveBeenCalledOnce();
});

it("does not replace newer denied authority with an older prepared result", async () => {
  const fixture = preparedFixture("prepared-denied");
  const denied = vi.fn(async () => null);
  const options = { ...fixture.options, resolveArtifactDownload: denied };
  expect(resolveAttachmentSource(fixture.attachment, options).status).toBe("checking");
  await Promise.resolve();
  await denied.mock.results[0]?.value;
  expect(resolveAttachmentSource(fixture.attachment, options).status).toBe("unavailable");
  admitManagedAttachmentGrant(fixture.receipt, fixture.attachment, fixture.expiresAt);
  fixture.receipt.release();
  expect(resolveAttachmentSource(fixture.attachment, options).status).toBe("unavailable");
  expect(denied).toHaveBeenCalledOnce();
});

it("retires an aborted receipt even when its empty resource is recreated", () => {
  const fixture = preparedFixture("prepared-retired");
  fixture.controller.abort();
  const replacement = prepareManagedAttachmentGrant(
    {
      sessionKey: "agent:main:prepared",
      artifactId: fixture.attachment.artifactId!,
      connectionEpoch: 31,
    },
    new AbortController().signal,
  );
  onTestFinished(replacement.release);
  admitManagedAttachmentGrant(fixture.receipt, fixture.attachment, fixture.expiresAt);
  expect(resolveAttachmentSource(fixture.attachment, fixture.options).status).toBe("checking");
});

it("does not admit a prepared grant over an in-flight renewal", async () => {
  const fixture = preparedFixture("prepared-pending");
  const response = Promise.withResolvers<{ url: string; expiresAt: string }>();
  const resolver = vi.fn(() => response.promise);
  const options = { ...fixture.options, resolveArtifactDownload: resolver };
  expect(resolveAttachmentSource(fixture.attachment, options).status).toBe("checking");
  await Promise.resolve();
  const pendingReceipt = prepareManagedAttachmentGrant(
    {
      sessionKey: "agent:main:prepared",
      artifactId: fixture.attachment.artifactId!,
      connectionEpoch: 31,
    },
    new AbortController().signal,
  );
  onTestFinished(pendingReceipt.release);
  admitManagedAttachmentGrant(pendingReceipt, fixture.attachment, fixture.expiresAt);
  expect(resolveAttachmentSource(fixture.attachment, options).status).toBe("checking");
  response.resolve({
    url: fixture.attachment.url.replace("mediaTicket=prepared", "mediaTicket=pending-owner"),
    expiresAt: fixture.expiresAt,
  });
  await response.promise;
  expect(resolveAttachmentSource(fixture.attachment, options)).toMatchObject({
    status: "available",
    source: {
      src: fixture.attachment.url.replace("mediaTicket=prepared", "mediaTicket=pending-owner"),
    },
  });
  expect(resolver).toHaveBeenCalledOnce();
});

it("bounds prepared grants before a reader adopts them", () => {
  vi.useFakeTimers();
  const sessionKey = "agent:main:bounded-prepared";
  const attachments = Array.from({ length: 65 }, (_, index): AttachmentItem["attachment"] => ({
    kind: "document",
    label: "Prepared PDF",
    mimeType: "application/pdf",
    artifactId: `bounded-${index}`,
    url: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/bounded-${index}/full?mediaTicket=prepared`,
  }));
  for (const attachment of attachments) {
    const receipt = prepareManagedAttachmentGrant(
      { sessionKey, artifactId: attachment.artifactId!, connectionEpoch: 41 },
      new AbortController().signal,
    );
    admitManagedAttachmentGrant(receipt, attachment, new Date(Date.now() + 300_000).toISOString());
    receipt.release();
  }
  const subscriber = vi.fn();
  subscribers.push(subscriber);
  const options = {
    connectionEpoch: 41,
    onMediaChange: subscriber,
    resolveArtifactDownload: vi.fn(async () => null),
  };
  expect(resolveAttachmentSource(attachments[64]!, options).status).toBe("available");
  expect(resolveAttachmentSource(attachments[0]!, options).status).toBe("checking");
});
