type MockCallSource = {
  mock: { calls: readonly (readonly unknown[])[] };
};

type TrackedOversizedJsonResponse = {
  response: Response;
  getReadCount: () => number;
  wasCanceled: () => boolean;
};

type FixedOversizedJsonResponse = {
  response: Response;
  state: { canceled: boolean; enqueuedBytes: number };
};

export function oversizedJsonResponse(): FixedOversizedJsonResponse;
export function oversizedJsonResponse(params: {
  chunkCount: number;
  chunkSize: number;
}): TrackedOversizedJsonResponse;
export function oversizedJsonResponse(params?: {
  chunkCount: number;
  chunkSize: number;
}): FixedOversizedJsonResponse | TrackedOversizedJsonResponse {
  // Cap the default stream at 64 MiB so a broken bounded reader fails
  // instead of hanging, while still forcing cancellation past the 16 MiB limit.
  const state = { canceled: false, enqueuedBytes: 0 };
  // Consumers only read these zero bytes; share the same immutable fixture chunk.
  const chunk = new Uint8Array(params ? params.chunkSize : 1024 * 1024);
  let readCount = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (readCount >= (params ? params.chunkCount : 64)) {
          controller.close();
          return;
        }
        readCount += 1;
        state.enqueuedBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        state.canceled = true;
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
  return params
    ? {
        response,
        getReadCount: () => readCount,
        wasCanceled: () => state.canceled,
      }
    : { response, state };
}

export function cancelTrackedResponse(init?: ResponseInit) {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("ignored"));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

export function bufferedOversizedJsonResponse(): Response {
  return new Response(Buffer.alloc(16 * 1024 * 1024 + 1, 0x20), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function streamedJsonResponse(payload: unknown): Response {
  // Keep a real body stream so bounded-reader tests exercise reads and cancellation.
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export function requireFirstPostJsonRequest(mock: MockCallSource, label: string): unknown {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call[0];
}

export function requireFirstPostJsonRecordRequest(
  mock: MockCallSource,
  label: string,
): Record<string, unknown> {
  const value = requireFirstPostJsonRequest(mock, label);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}
