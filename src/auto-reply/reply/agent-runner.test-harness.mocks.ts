import { vi } from "vitest";

export function modelFallbackMockFactory(): Record<string, unknown> {
  return {
    runWithModelFallback: async ({
      provider,
      model,
      run,
    }: {
      provider: string;
      model: string;
      run: (provider: string, model: string) => Promise<unknown>;
    }) => ({
      result: await run(provider, model),
      provider,
      model,
    }),
  };
}

export function embeddedPiMockFactory(state: {
  runEmbeddedPiAgentMock: (params: unknown) => unknown;
}): Record<string, unknown> {
  return {
    queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
    runEmbeddedPiAgent: (params: unknown) => state.runEmbeddedPiAgentMock(params),
  };
}

export async function queueMockFactory(): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
}
