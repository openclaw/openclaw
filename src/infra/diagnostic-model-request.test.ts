import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitTrustedDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "./diagnostic-events.js";
import type { CoreModelRequestOwnerGeneration } from "./diagnostic-model-request-provenance.js";
import { resolveCoreModelRequestLifecycleDiagnosticMetadata } from "./diagnostic-model-request.js";

describe("core model request provenance", () => {
  beforeEach(() => resetDiagnosticEventsForTest());
  afterEach(() => resetDiagnosticEventsForTest());

  it("keeps duplicate-emitter provenance attached to its FIFO event", async () => {
    const events: Array<{
      callId: string;
      coreRequest: boolean;
      generation?: CoreModelRequestOwnerGeneration;
    }> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      if (event.type === "model.call.started") {
        const provenance = resolveCoreModelRequestLifecycleDiagnosticMetadata(metadata);
        events.push({
          callId: event.callId,
          coreRequest: provenance?.phase === "started",
          generation: provenance?.generation,
        });
      }
    });

    vi.resetModules();
    const duplicateModelRequest = await import(
      /* @vite-ignore */ new URL("./diagnostic-model-request.ts?duplicate", import.meta.url).href
    );
    const generation = Object.freeze({
      id: "fifo-generation",
    }) satisfies CoreModelRequestOwnerGeneration;
    duplicateModelRequest.emitCoreModelRequestStartedDiagnosticEvent(
      {
        runId: "fifo-run",
        callId: "core-before",
        provider: "mock",
        model: "request-model",
      },
      generation,
    );
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "fifo-run",
      callId: "public-middle",
      provider: "mock",
      model: "request-model",
      observationUnit: "request",
    });
    duplicateModelRequest.emitCoreModelRequestStartedDiagnosticEvent(
      {
        runId: "fifo-run",
        callId: "core-after",
        provider: "mock",
        model: "request-model",
      },
      generation,
    );
    await waitForDiagnosticEventsDrained();

    expect(events).toEqual([
      { callId: "core-before", coreRequest: true, generation },
      { callId: "public-middle", coreRequest: false, generation: undefined },
      { callId: "core-after", coreRequest: true, generation },
    ]);
    expect(events[0]?.generation).toBe(generation);
    expect(events[2]?.generation).toBe(generation);
  });
});
