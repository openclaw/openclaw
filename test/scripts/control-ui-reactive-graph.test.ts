import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { installControlUiReactiveGraph } from "../../scripts/lib/control-ui-reactive-graph-browser.ts";

it("counts real Solid executions, unchanged outputs, and shared-write fan-out without retaining prior captures", async () => {
  const requireUi = createRequire(new URL("../../ui/package.json", import.meta.url));
  const runtimeDir = path.dirname(requireUi.resolve("@solidjs/signals"));
  const [runtime, { attribution }] = await Promise.all([
    import(pathToFileURL(path.resolve(runtimeDir, "../dev.js")).href),
    import(pathToFileURL(path.resolve(runtimeDir, "../dev.attribution.js")).href),
  ]);
  const probe = installControlUiReactiveGraph(runtime.OBSERVE, attribution);
  let disposeRoot = () => {};
  try {
    const update = runtime.createRoot((dispose: () => void) => {
      disposeRoot = dispose;
      const [value, setValue] = runtime.createSignal(0, { name: "input" });
      const parity = runtime.createMemo(() => value() % 2, {
        name: "parity",
        loc: "fixture.ts:1:1",
      });
      runtime.createEffect(
        () => parity(),
        () => {},
        { name: "narrow" },
      );
      runtime.createEffect(
        () => value() % 2,
        () => {},
        { name: "direct" },
      );
      return setValue;
    });
    runtime.flush();
    probe.start("three writes");
    for (const value of [2, 4, 5]) {
      update(value);
      runtime.flush();
    }
    const result = probe.stop();
    expect(result).toMatchObject({
      label: "three writes",
      creations: 0,
      reruns: 7,
      unchanged: 4,
      effectRuns: 4,
    });
    expect(result.scopes.find((scope) => scope.name === "parity")).toMatchObject({
      source: "fixture.ts:1:1",
      instances: 1,
      reruns: 3,
      unchanged: 2,
    });
    expect(result.writes.find((write) => write.name === "input")).toMatchObject({
      writes: 3,
      downstreamRuns: 7,
      readers: 3,
      maxReadersPerWrite: 3,
    });
    probe.start("unchanged writes");
    update(5);
    runtime.flush();
    expect(probe.stop()).toMatchObject({
      label: "unchanged writes",
      reruns: 0,
      scopes: [],
      writes: [],
    });
  } finally {
    disposeRoot();
    probe.dispose();
  }
});
