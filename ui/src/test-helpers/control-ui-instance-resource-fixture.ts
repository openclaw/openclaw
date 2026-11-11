import { bootstrapApplication, type ApplicationRuntime } from "../app/bootstrap.ts";
import type { ControlUiMockGateway } from "./control-ui-e2e-contract.ts";
import {
  createInstanceResourceProbe,
  type InstanceNativeCheckpoint,
} from "./control-ui-instance-resource-probe.ts";
import type {
  InstanceResourceFamily,
  ProjectionFixtureFacts,
} from "./control-ui-projection-fixture-contract.ts";

type InstanceResourceFacts = ProjectionFixtureFacts & {
  nativeCheckpoints: InstanceNativeCheckpoint[];
  assertions: string[];
};
export type InstanceGroup = {
  label: string;
  root: HTMLElement;
  runtime: ApplicationRuntime;
  count: number;
};
export function instanceAssert(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}
export const instanceSettle = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
export async function instanceWait(check: () => boolean, message: string) {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    if (performance.now() > deadline) {
      throw new Error(message);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}
export function instanceGateway(): ControlUiMockGateway {
  const gateway: unknown = Reflect.get(window, "openclawControlUiE2eGateway");
  instanceAssert(gateway, "The native resource fixture requires the existing synthetic Gateway");
  return gateway as ControlUiMockGateway;
}
function createInstanceContext(family: InstanceResourceFamily, instrumented: boolean) {
  instanceAssert(
    location.pathname.endsWith("/instance-resource-fixture.html"),
    "Use the isolated benchmark document; the normal shell would pre-own shared observers",
  );
  instanceAssert(
    !document.querySelector("openclaw-app"),
    "The native resource fixture cannot share the shell document",
  );
  const theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeMode = theme;
  document.documentElement.dataset.themeResolved = theme;
  const probe = instrumented ? createInstanceResourceProbe() : undefined;
  const facts: InstanceResourceFacts = {
    family,
    instrumented,
    mounted: [],
    checkpoints: [],
    nativeCheckpoints: [],
    assertions: [],
  };
  const groups: InstanceGroup[] = [];
  const stop: Array<() => void> = [];
  const capture = (phase: string) => {
    if (!probe) {
      return;
    }
    facts.checkpoints.push({ phase, counts: probe.sources.snapshot() });
    facts.nativeCheckpoints.push(probe.native(phase));
  };
  return {
    facts,
    groups,
    stop,
    probe,
    capture,
    async group(label: string, count: number) {
      const runtime = bootstrapApplication();
      const root = document.createElement("section");
      root.dataset.projectionApplication = label;
      root.style.cssText =
        "display:grid;gap:4px;grid-template-columns:repeat(5,minmax(0,1fr));font-size:12px";
      document.body.append(root);
      const group = { label, count, root, runtime };
      groups.push(group);
      await runtime.start();
      await instanceWait(
        () => runtime.context.gateway.snapshot.phase === "connected",
        `Native Gateway ${label} did not connect`,
      );
      return group;
    },
    recordMounted(group: Pick<InstanceGroup, "label" | "count">, actual: number) {
      instanceAssert(
        actual === group.count,
        `${family}/${group.label}: expected ${group.count} consumers, got ${actual}`,
      );
      facts.mounted.push({ application: group.label, expected: group.count, actual });
    },
    result: () => structuredClone(facts),
    dispose(this: void) {
      for (const cleanup of stop.toReversed()) {
        cleanup();
      }
      for (const group of groups.toReversed()) {
        group.root.remove();
        group.runtime.stop();
      }
      probe?.dispose();
    },
  };
}
export type InstanceContext = ReturnType<typeof createInstanceContext>;

export function createInstanceResourceFixture(
  family: InstanceResourceFamily,
  instrumented: boolean,
) {
  const context = createInstanceContext(family, instrumented);
  let delegate:
    | {
        setup(): Promise<InstanceResourceFacts>;
        run(): Promise<InstanceResourceFacts>;
        finish(): Promise<InstanceResourceFacts>;
      }
    | undefined;
  return {
    async setup() {
      context.capture("before-modules");
      if (family === "link-providers" || family === "link-metadata") {
        const module = await import("./control-ui-provider-resource-fixture.ts");
        delegate = await module.createInstanceConsumers(context, family);
      } else {
        const module =
          family === "tooltips"
            ? await import("./control-ui-tooltip-resource-fixture.ts")
            : family === "ci-pairs"
              ? await import("./control-ui-ci-resource-fixture.ts")
              : await import("./control-ui-clawhub-resource-fixture.tsx");
        delegate = await module.createInstanceConsumers(context);
      }
      return delegate.setup();
    },
    run() {
      instanceAssert(delegate, "Instance resource fixture has not mounted");
      return delegate.run();
    },
    finish() {
      instanceAssert(delegate, "Instance resource fixture has not mounted");
      return delegate.finish();
    },
    dispose: context.dispose,
  };
}
