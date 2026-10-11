import path from "node:path";

export function solidFixtureFiles(repoRoot: string): Record<string, string> {
  const mount = JSON.stringify(path.join(repoRoot, "ui/src/test-helpers/mount-solid.ts"));
  const signals = JSON.stringify(
    path.join(repoRoot, "ui/node_modules/@solidjs/signals/dist/dev.js"),
  );
  const imports = `import { createEffect, createSignal, onCleanup, flush } from "solid-js";
import { createSignal as coreSignal } from ${signals};
import { render } from "@solidjs/web";
import { mountSolid } from ${mount};
import { expect, it } from "vitest";`;
  return {
    "13-a-solid-producer.test.ts": `/* @vitest-environment jsdom */
${imports}
it("mounts a reactive root before worker cleanup", () => {
  const [read, write] = createSignal(0);
  const state = globalThis.__solidFixture = { createSignal, coreSignal, render, read, write, disposed: false, effects: 0 };
  const view = mountSolid(() => {
    const output = document.createElement("output");
    createEffect(read, value => { state.effects++; output.textContent = String(value); });
    onCleanup(() => { state.disposed = true; });
    return output;
  });
  expect(view.container.textContent).toBe("0");
  write(1);
  flush();
  expect(view.container.textContent).toBe("1");
});
`,
    "13-b-solid-observer.test.ts": `/* @vitest-environment jsdom */
${imports}
it("retains one runtime and cleans old roots across consecutive files", () => {
  const prior = globalThis.__solidFixture;
  delete globalThis.__solidFixture;
  expect(prior.createSignal).toBe(createSignal);
  expect(prior.coreSignal).toBe(coreSignal);
  expect(prior.render).toBe(render);
  expect(prior.disposed).toBe(true);
  expect(document.body.childNodes).toHaveLength(0);
  const view = mountSolid(() => {
    const output = document.createElement("output");
    createEffect(prior.read, value => { output.textContent = String(value); });
    return output;
  });
  expect(view.container.textContent).toBe("1");
  prior.write(2);
  flush();
  expect(view.container.textContent).toBe("2");
  expect(prior.effects).toBe(2);
});
`,
  };
}
