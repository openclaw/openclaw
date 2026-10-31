import {
  instanceAssert as assert,
  instanceSettle as settle,
  type InstanceContext,
  type InstanceGroup,
} from "./control-ui-instance-resource-fixture.ts";
export function observe(context: InstanceContext, group: InstanceGroup) {
  context.probe?.sources.observeSource(group.runtime.context.gateway, `${group.label}.gateway`);
  context.probe?.sources.observeSource(
    group.runtime.context.gateway,
    `${group.label}.events`,
    undefined,
    "subscribeEvents",
  );
}
export async function publish(context: InstanceContext) {
  const [a, b] = context.groups;
  assert(
    a && b && a.runtime.context.gateway !== b.runtime.context.gateway,
    "Card fixtures require independent native gateways",
  );
  assert(
    a.runtime.context.gateway.snapshot.client !== b.runtime.context.gateway.snapshot.client,
    "Card fixtures require independent native clients",
  );
  const bSnapshot = b.runtime.context.gateway.snapshot;
  const before = context.probe?.sources.snapshot();
  for (let revision = 0; revision < 20; revision++) {
    a.runtime.context.gateway.setSessionKey(`agent:main:instance-publication-${revision}`);
    await settle();
  }
  assert(
    b.runtime.context.gateway.snapshot === bSnapshot,
    "Publishing A replaced B's native snapshot",
  );
  const after = context.probe?.sources.snapshot();
  if (before && after) {
    for (const [name, counts] of Object.entries(after.sources)) {
      if (name.startsWith("B.")) {
        assert(
          counts.callbacks === before.sources[name]?.callbacks,
          `A delivered native callback to ${name}`,
        );
      }
    }
  }
  context.capture("20-native-A-snapshots");
}
