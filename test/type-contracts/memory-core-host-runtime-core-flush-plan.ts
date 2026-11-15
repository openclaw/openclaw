// Released memory plugins build and consume `flushPlanResolver` results as complete
// `MemoryFlushPlan`s; host-completed plans use the separate provider resolver.
import { expectTypeOf } from "vitest";
import type {
  MemoryFlushFilePlanDraft,
  MemoryFlushPlan,
  MemoryFlushToolsPlan,
} from "../../src/plugin-sdk/memory-core-host-runtime-core.js";
import type { MemoryPluginCapability } from "../../src/plugin-sdk/memory-host-core.js";

type ReleasedResolver = NonNullable<MemoryPluginCapability["flushPlanResolver"]>;
type ProviderResolverResult = NonNullable<
  ReturnType<NonNullable<MemoryPluginCapability["providerFlushPlanResolver"]>>
>;

expectTypeOf<ReturnType<ReleasedResolver>>().toEqualTypeOf<MemoryFlushPlan | null>();
const resolver: ReleasedResolver = () => ({
  softThresholdTokens: 4_000,
  forceFlushTranscriptBytes: 1_024,
  reserveTokensFloor: 20_000,
  prompt: "flush",
  systemPrompt: "flush",
  relativePath: "memory/2026-10-02.md",
});
// A released consumer null-checks the result and reads every field without narrowing.
const plan = resolver({});
if (!plan) {
  throw new Error("expected a flush plan");
}
const filePlan: MemoryFlushPlan = plan;
void filePlan.relativePath;
void filePlan.softThresholdTokens;

expectTypeOf<MemoryFlushPlan>().toMatchTypeOf<ProviderResolverResult>();
expectTypeOf<MemoryFlushFilePlanDraft>().toMatchTypeOf<ProviderResolverResult>();
expectTypeOf<MemoryFlushToolsPlan>().toMatchTypeOf<ProviderResolverResult>();
const released: ReleasedResolver = () => null;
const reused: NonNullable<MemoryPluginCapability["providerFlushPlanResolver"]> = released;
void reused({});
