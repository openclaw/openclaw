import { expectDefined } from "@openclaw/normalization-core/expect";
import { runCapability } from "./runner.js";
import { withAudioFixture, withVideoFixture } from "./runner.test-utils.js";

type RunParams = Parameters<typeof runCapability>[0];
export async function runMediaFixture(
  capability: "audio" | "video",
  prefix: string,
  params: Omit<RunParams, "capability" | "ctx" | "media" | "attachments">,
) {
  let result: Awaited<ReturnType<typeof runCapability>> | undefined;
  const withFixture = capability === "audio" ? withAudioFixture : withVideoFixture;
  await withFixture(prefix, async ({ ctx, media, cache }) => {
    result = await runCapability({ ...params, capability, ctx, media, attachments: cache });
  });
  return expectDefined(result, "media fixture result");
}
