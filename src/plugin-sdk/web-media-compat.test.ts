import { expectTypeOf, it } from "vitest";
import type { pruneStaleTrustedGeneratedHtmlMarkers } from "../media/web-media.js";

it("retains the cleanup signature carried by released SDK declarations", () => {
  expectTypeOf<Parameters<typeof pruneStaleTrustedGeneratedHtmlMarkers>>().toEqualTypeOf<[]>();
  expectTypeOf<ReturnType<typeof pruneStaleTrustedGeneratedHtmlMarkers>>().toEqualTypeOf<
    Promise<void>
  >();
});
