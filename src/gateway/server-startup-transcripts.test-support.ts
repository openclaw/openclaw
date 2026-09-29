import { beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const transcriptsAutoStartService = {
    start: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const transcriptCapturePolicy = {
    drain: vi.fn(async () => {}),
    resume: vi.fn(),
  };
  return {
    transcriptsAutoStartService,
    transcriptCapturePolicy,
    createTranscriptsAutoStartService: vi.fn(() => transcriptsAutoStartService),
    prepareTranscriptCaptureDisable: vi.fn((_stateDir: string) => transcriptCapturePolicy),
  };
});

export const transcriptSidecarMocks = mocks;

vi.mock("../transcripts/auto-start.js", () => ({
  createTranscriptsAutoStartService: mocks.createTranscriptsAutoStartService,
}));

vi.mock("../transcripts/capture-operations.js", () => ({
  prepareTranscriptCaptureDisable: mocks.prepareTranscriptCaptureDisable,
}));

beforeEach(() => {
  mocks.transcriptsAutoStartService.start.mockReset();
  mocks.transcriptsAutoStartService.stop.mockReset().mockResolvedValue(undefined);
  mocks.createTranscriptsAutoStartService.mockClear();
  mocks.transcriptCapturePolicy.drain.mockReset().mockResolvedValue(undefined);
  mocks.transcriptCapturePolicy.resume.mockClear();
  mocks.prepareTranscriptCaptureDisable.mockClear();
});
