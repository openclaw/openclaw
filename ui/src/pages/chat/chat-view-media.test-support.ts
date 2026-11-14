import { expect, type Mock } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";

/** Shared callback contract for history, streaming, and continuation image activation. */
export async function expectInlineImageOpened(
  onOpenImage: Mock,
  src: string,
  requestVersion: number,
) {
  await waitForFast(() =>
    expect(onOpenImage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        src,
        title: "Synthetic preview",
        readOriginalBlob: expect.any(Function),
      }),
      requestVersion,
    ),
  );
}
