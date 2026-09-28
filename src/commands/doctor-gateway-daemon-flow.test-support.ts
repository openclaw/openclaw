/** Prompt fixture for interactive Doctor service repair. */
import { vi } from "vitest";

export function createPrompter(confirmImpl: (message: string) => boolean) {
  return {
    confirm: vi.fn(),
    confirmAutoFix: vi.fn(),
    confirmAggressiveAutoFix: vi.fn(),
    confirmRuntimeRepair: vi.fn(async ({ message }: { message: string }) => confirmImpl(message)),
    select: vi.fn(),
    shouldRepair: false,
    shouldForce: false,
    repairMode: {
      shouldRepair: false,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
      updateInProgress: false,
    },
  };
}

export function setPlatform(platform: NodeJS.Platform) {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!originalPlatformDescriptor) {
    return;
  }
  Object.defineProperty(process, "platform", {
    ...originalPlatformDescriptor,
    value: platform,
  });
}
