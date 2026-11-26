// PROTOTYPE (perf/lean-consolidation-prototype): measurement knobs, read once from
// OPENCLAW_LEAN_PROTO, for example "hostKinds=1,hostAll=1". Not a config surface.
const knobs = new Map(
  (process.env.OPENCLAW_LEAN_PROTO ?? "")
    .split(",")
    .filter(Boolean)
    .map((pair): [string, number] => {
      const [name = "", value = ""] = pair.split("=");
      return [name, Number(value)];
    })
    .filter(([, value]) => Number.isFinite(value) && value >= 0),
);

export const leanPrototype = {
  /** Host the additional task-served kinds in the shared worker host. */
  hostMoreKinds: knobs.get("hostKinds") === 1,
  /** Host every slot of a hosted kind, not only the first. */
  hostEverySlot: knobs.get("hostAll") === 1,
  /** Old-generation limit of the shared host isolate, MiB. */
  hostOldGenerationMiB: knobs.get("hostOld"),
};
