import { expect, it, vi, type Mock } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";

type OutputFixture = { dir: string; outputBase: string; outputPath: string };

export function registerVideoOutputCapabilityCliTests({
  mocks,
  generateVideo,
  primeGeneratedVideoUrl,
  mockVideoFetch,
  outputFixture,
  expectOutputFile,
  expectRuntimeErrorContains,
}: {
  mocks: {
    generateVideo: Mock;
    runtime: { writeJson: Mock; error: Mock; exit: Mock };
  };
  generateVideo: (...args: string[]) => Promise<void>;
  primeGeneratedVideoUrl: (url: string) => void;
  mockVideoFetch: (body: ConstructorParameters<typeof Response>[0]) => Mock;
  outputFixture: (extension: string, original: string) => Promise<OutputFixture>;
  expectOutputFile: (fixture: OutputFixture, contents: string) => Promise<void>;
  expectRuntimeErrorContains: (expected: string) => void;
}): void {
  it("preserves atomic video output on stream failure and accepted interruptions", async () => {
    primeGeneratedVideoUrl("https://example.com/broken-video.mp4");
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial-video"));
        controller.error(new Error("video stream exploded"));
      },
    });
    mockVideoFetch(broken);
    const failed = await outputFixture(".mp4", "keep-existing-video");
    await expect(generateVideo("--output", failed.outputBase)).rejects.toThrow("exit 1");
    expectRuntimeErrorContains("video stream exploded");
    await expectOutputFile(failed, "keep-existing-video");

    for (const phase of ["during", "before"] as const) {
      vi.clearAllMocks();
      const scope = new AsyncWorkScope();
      const fixture = await outputFixture(".mp4", "keep-existing-video");
      const stopReason = new DOMException("CLI stopping (SIGINT)", "AbortError");
      if (phase === "before") {
        const fetchMock = mockVideoFetch(Buffer.from("video-bytes"));
        mocks.generateVideo.mockImplementationOnce(async () => {
          scope.beginClose(stopReason);
          return {
            provider: "vydra",
            model: "veo3",
            attempts: [],
            videos: [
              {
                url: "https://example.com/late-video.mp4",
                mimeType: "video/mp4",
                fileName: "late.mp4",
              },
            ],
          };
        });
        await scope.track(() => generateVideo("--output", fixture.outputBase));
        expect(fetchMock).not.toHaveBeenCalled();
      } else {
        primeGeneratedVideoUrl("https://example.com/generated-video.mp4");
        const started = createDeferredCore();
        const release = createDeferredCore();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("partial-video"));
            await release.promise;
            try {
              controller.enqueue(new TextEncoder().encode("-bytes"));
              controller.close();
            } catch {
              // Cancellation has already closed the download body.
            }
          },
        });
        const downloadSignal = createDeferredCore<AbortSignal | undefined>();
        const fetchMock = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
          downloadSignal.resolve(init?.signal);
          started.resolve();
          return new Response(stream, { headers: { "content-type": "video/mp4" } });
        });
        vi.stubGlobal("fetch", fetchMock);
        const running = scope.track(() => generateVideo("--output", fixture.outputBase));
        await started.promise;
        scope.beginClose(stopReason);
        release.resolve();
        await running;
        expect((await downloadSignal.promise)?.reason).toBe(stopReason);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
      await expectOutputFile(fixture, "keep-existing-video");
      expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
      expect(mocks.runtime.error).not.toHaveBeenCalled();
      expect(mocks.runtime.exit).not.toHaveBeenCalled();
    }
  });
}
