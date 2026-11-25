// Real mock-resolution work must finish before the shared worker resets its registry.
export const mockResolutionFixtureFiles = {
  "09-c1-resolution-producer.test.ts": `import { expect, it, vi } from "vitest";
import { setImmediate } from "node:timers";
it("joins a later resolution pass before resetting mocks", async () => {
  const mocker = globalThis.__vitest_mocker__;
  const resolveId = mocker.resolveId;
  const reset = mocker.reset;
  const state = globalThis.__resolutionCleanup = { first: false, late: false, reset: false };
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  mocker.resolveId = async function (id, importer) {
    if (id === "./01-dep.js") {
      entered();
      await gate;
      vi.doMock("./01-mid.js", () => ({ describeFlavor: () => "leaked" }));
    }
    if (id === "./09-redirect-dep.js") {
      await new Promise(setImmediate);
    }
    return resolveId.call(this, id, importer);
  };
  mocker.reset = function () {
    mocker.resolveId = resolveId;
    mocker.reset = reset;
    expect(state.first).toBe(true);
    expect(state.late).toBe(true);
    state.reset = true;
    return reset.call(this);
  };
  vi.doMock("./01-dep.js", () => ({ flavor: () => "first" }));
  const first = mocker.resolveMocks();
  first.then(() => {
    state.first = true;
    vi.doMock("./09-redirect-dep.js", () => ({ flavor: "late" }));
    return mocker.resolveMocks().then(() => { state.late = true; });
  }).catch(error => { state.error = String(error); });
  await started;
  expect(state.first).toBe(false);
  // Let file cleanup enter its join before the resolver finishes and queues another pass.
  setImmediate(release);
});
`,
  "09-c2-resolution-observer.test.ts": `import { expect, it } from "vitest";
import { flavor } from "./01-dep.js";
import { describeFlavor } from "./01-mid.js";
it("starts after every native resolution has settled and the registry is reset", () => {
  expect(globalThis.__resolutionCleanup).toEqual({ first: true, late: true, reset: true });
  expect(flavor()).toBe("real");
  expect(describeFlavor()).toBe("flavor:real");
  delete globalThis.__resolutionCleanup;
});
`,
};
