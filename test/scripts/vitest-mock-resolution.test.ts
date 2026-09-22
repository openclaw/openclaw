import { sep } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../helpers/promise.js";

// Vitest publishes the active mocker. Gate its real resolver to exercise the
// installed dependency's fetch boundary, rather than emulating its queue.
// oxlint-disable-next-line eslint/no-underscore-dangle -- Vitest owns this exact published global name.
declare const __vitest_mocker__: {
  resolveId: (id: string, importer?: string) => Promise<unknown>;
  resolveMocks: () => Promise<void>;
  moduleRunner: {
    vitestOptions: {
      transport: { fetchModule: (...args: unknown[]) => Promise<unknown> };
    };
  };
};

afterEach(async () => {
  vi.doUnmock("node:path");
  vi.doUnmock("node:os");
  await __vitest_mocker__.resolveMocks();
  vi.resetModules();
});

it("waits for an in-flight unmock before another import reads its registry", async () => {
  vi.doMock("node:path", () => ({ sep: "mocked" }));
  expect((await import("node:path")).sep).toBe("mocked");
  const mocker = __vitest_mocker__;
  const transport = mocker.moduleRunner.vitestOptions.transport;
  const resolveId = mocker.resolveId;
  const fetchModule = transport.fetchModule;
  const resolving = createDeferred();
  const release = createDeferred();
  const fetching = createDeferred();
  let observeFetch = false;
  mocker.resolveId = async (id, importer) => {
    if (id === "node:path") {
      resolving.resolve();
      await release.promise;
    }
    return resolveId.call(mocker, id, importer);
  };
  transport.fetchModule = (...args) => {
    const result = fetchModule.apply(transport, args);
    if (observeFetch && args[0] === "node:path") {
      fetching.resolve();
    }
    return result;
  };
  vi.doUnmock("node:path");
  const first = import("node:os");
  let second: Promise<string> | undefined;
  try {
    await resolving.promise;
    observeFetch = true;
    let completed = false;
    second = import("node:path").then((module) => {
      completed = true;
      return module.sep;
    });
    await fetching.promise;
    await nextTurn();
    expect.soft(completed).toBe(false);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
    mocker.resolveId = resolveId;
    transport.fetchModule = fetchModule;
  }
  await expect(first).resolves.toBeDefined();
  await expect(second).resolves.toBe(sep);
});

it("allows a mock factory to import actual exports and register another mock", async () => {
  vi.doMock("node:path", async () => {
    const actual = await vi.importActual<typeof import("node:path")>("node:path");
    vi.doMock("node:os", () => ({ type: () => "nested" }));
    const nested = await import("node:os");
    return { sep: `${actual.sep}:${nested.type()}` };
  });
  expect((await import("node:path")).sep).toBe(`${sep}:nested`);
});

it("reports a failed resolution without poisoning the next caller's mock", async () => {
  const mocker = __vitest_mocker__;
  const resolveId = mocker.resolveId;
  const resolving = createDeferred();
  const release = createDeferred();
  const failure = new Error("synthetic mock resolution failure");
  mocker.resolveId = async (id, importer) => {
    if (id === "node:path") {
      resolving.resolve();
      await release.promise;
      throw failure;
    }
    return resolveId.call(mocker, id, importer);
  };
  vi.doMock("node:path", () => ({ sep: "unresolved" }));
  const first = import("node:path").catch((error: unknown) => error);
  let second: Promise<typeof import("node:os")> | undefined;
  try {
    await resolving.promise;
    vi.doMock("node:os", () => ({ type: () => "recovered" }));
    second = import("node:os");
    release.resolve();
    expect(await first).toMatchObject({ name: "Error", message: failure.message });
    expect((await second).type()).toBe("recovered");
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
    mocker.resolveId = resolveId;
  }
});
