import { expectTypeOf } from "vitest";
import type { pruneStaleTrustedGeneratedHtmlMarkers } from "../../src/media/web-media.js";

// Preserve the cleanup signature carried by released SDK declarations.
expectTypeOf<Parameters<typeof pruneStaleTrustedGeneratedHtmlMarkers>>().toEqualTypeOf<[]>();
expectTypeOf<ReturnType<typeof pruneStaleTrustedGeneratedHtmlMarkers>>().toEqualTypeOf<
  Promise<void>
>();
