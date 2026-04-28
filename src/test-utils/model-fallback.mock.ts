import { vi } from "vitest";

export const runWithModelFallback = vi.fn(
  async (params: {
    provider: string;
    model: string;
    transientRetry?: { enabled?: boolean; runIsIdempotent?: boolean };
    run: (
      provider: string,
      model: string,
      options?: { allowTransientCooldownProbe?: boolean },
    ) => Promise<unknown>;
  }) => {
    return {
      result: await params.run(params.provider, params.model),
      provider: params.provider,
      model: params.model,
    };
  },
);
