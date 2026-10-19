import { afterEach, beforeEach, onTestFinished, vi } from "vitest";
import { RealtimeTalkInputOwner } from "./input.ts";

export async function prepareRealtimeTalkTestInput(
  inputDeviceId?: string,
): Promise<RealtimeTalkInputOwner> {
  const input = new RealtimeTalkInputOwner(() => undefined);
  onTestFinished(() => input.stop());
  await input.open(inputDeviceId);
  return input;
}

export function useRealtimeTalkMicrophoneFixture(): void {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          const track = Object.assign(new EventTarget(), { stop: vi.fn() });
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        }),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());
}
