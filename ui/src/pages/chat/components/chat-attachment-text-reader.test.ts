import { afterEach, describe, expect, it, vi } from "vitest";
import { readAttachmentText } from "./chat-attachment-text-reader.ts";

describe("readAttachmentText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("settles a data: URL abort after response delivery as AbortError instead of an uncaught native error", async () => {
    const controller = new AbortController();
    const realFetch = globalThis.fetch;
    // Abort deterministically inside the crash window: the response is delivered
    // but the reader has not consumed its body yet.
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const response = await realFetch(input, init);
        controller.abort();
        return response;
      },
    );

    await expect(
      readAttachmentText(
        "data:text/plain,Restored%20text",
        undefined,
        controller.signal,
        "excerpt",
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("still reads data: URL text when the signal stays quiet", async () => {
    await expect(
      readAttachmentText(
        "data:text/plain,Restored%20text",
        undefined,
        new AbortController().signal,
        "excerpt",
      ),
    ).resolves.toBe("Restored text");
  });

  it("still forwards the signal for remote URLs so real cancellation failures reject", async () => {
    const controller = new AbortController();
    let handedSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      handedSignal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      });
    });

    const pending = readAttachmentText(
      "https://attachments.invalid/pasted.txt",
      undefined,
      controller.signal,
      "excerpt",
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(handedSignal).toBeInstanceOf(AbortSignal);
    expect(handedSignal?.aborted).toBe(true);
  });
});
