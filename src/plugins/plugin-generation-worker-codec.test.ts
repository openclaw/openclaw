import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it, vi } from "vitest";
import { markPluginSourceCaptureOperation } from "./plugin-generation-source-lookup.js";
import {
  GenerationCodec,
  type GenerationNativeRootTransport,
} from "./plugin-generation-worker-codec.js";
import { markPluginSourcePreparationOperation } from "./plugin-instance-error.js";
import { restorePluginNativeRecovery } from "./plugin-native-admission.js";
import { retainPluginNativeRoot } from "./plugin-native-root-lease.js";

function nativeRootTransport(): GenerationNativeRootTransport {
  const roots: Parameters<GenerationNativeRootTransport["exportRoot"]>[0][] = [];
  return {
    exportRoot(root) {
      const existing = roots.indexOf(root);
      return existing === -1 ? roots.push(root) - 1 : existing;
    },
    importRoot: (id) => retainPluginNativeRoot(roots[id]!),
  };
}

const disposable = () => ({ dispose() {}, async disposeAsync() {} });

it("attests source preparation handles independently of callback names and capture deadlines", () => {
  const sender = new GenerationCodec(() => undefined, nativeRootTransport());
  const prepare = sender.encode(markPluginSourcePreparationOperation(() => undefined));
  const callback = sender.encode(function prepareModule() {});
  expect(prepare.kind).toBe("function");
  expect(callback.kind).toBe("function");
  if (prepare.kind !== "function" || callback.kind !== "function") {
    throw new Error("Expected function handles");
  }
  expect(sender.isSourcePreparationCall(prepare.id)).toBe(true);
  expect(sender.isSourcePreparationCall(callback.id)).toBe(false);
  expect(prepare.sourceCapture).toBe(false);
  expect(sender.isSourcePreparationCall(-1)).toBe(false);
});
const weak = (...values: object[]) => values.map((value) => new WeakRef(value));
async function expectCollected(references: WeakRef<object>[]) {
  const control = new WeakRef({});
  await nextTurn();
  queryObjects(WeakRef);
  expect(control.deref()).toBeUndefined();
  expect(references.map((reference) => reference.deref())).toEqual(references.map(() => undefined));
}

function resourceTransport() {
  const nativeRoots = nativeRootTransport();
  const sender = new GenerationCodec(() => undefined, nativeRoots);
  const accept = (value: unknown, handle?: number) => {
    const encoded =
      handle === undefined ? sender.encode(value) : sender.encodeResult(value, handle);
    receiver.releaseReceivedHandles(sender.takeReleasedHandles());
    return receiver.decode(encoded);
  };
  const receiver = new GenerationCodec((handle, args, asynchronous) => {
    try {
      const result = sender.call(handle, receiver.encodeArguments(args));
      return asynchronous
        ? Promise.resolve(result).then((value) => accept(value, handle))
        : accept(result, handle);
    } catch (error) {
      receiver.releaseReceivedHandles(sender.takeReleasedHandles());
      throw error;
    }
  }, nativeRoots);
  function own<T extends { dispose(): void; disposeAsync(): Promise<void> }>(resource: T): T {
    sender.retainResource(resource);
    const dispose = resource.dispose.bind(resource);
    const disposeAsync = resource.disposeAsync.bind(resource);
    resource.dispose = () => {
      dispose();
      sender.releaseResource(resource);
    };
    resource.disposeAsync = async () => {
      await disposeAsync();
      sender.releaseResource(resource);
    };
    return resource;
  }
  return { own, exchange: <T>(value: T): T => accept(value) as T };
}

it.each(["sync", "async"])(
  "collects disposed %s recovery graphs while another artifact stays live",
  async (mode) => {
    const transport = resourceTransport();
    const parent = transport.exchange(transport.own({ value: () => 42, ...disposable() }));
    async function recovery() {
      const payload = { value: "captured source" };
      const original = transport.own({
        sourceCapture: { read: () => payload },
        fork: () => payload,
        ...disposable(),
      });
      const decoded = transport.exchange(original);
      expect(decoded.sourceCapture.read()).toEqual(payload);
      const references = weak(original, payload, decoded.fork, decoded.sourceCapture.read);
      if (mode === "sync") {
        decoded.dispose();
        await decoded.disposeAsync();
      } else {
        await decoded.disposeAsync();
        decoded.dispose();
      }
      return references;
    }
    const references = await recovery();
    await expectCollected(references);
    expect(parent.value()).toBe(42);
    await recovery();
    await parent.disposeAsync();
  },
);

it.each(["sync", "async"])("releases %s method replies after their last owner", async (mode) => {
  const transport = resourceTransport();
  async function cycle() {
    const payload = { value: 42 };
    const read = () => payload;
    const facts = () => ({ read });
    const factsAsync = async () => facts();
    const create = () => transport.own({ facts, factsAsync, ...disposable() });
    const [first, second] = transport.exchange([create(), create()]);
    const reply = mode === "async" ? await first!.factsAsync() : first!.facts();
    first!.dispose();
    expect(reply.read()).toEqual({ value: 42 });
    const references = weak(payload, read, reply.read);
    await second!.disposeAsync();
    return references;
  }
  const references = await cycle();
  await expectCollected(references);
});

it("keeps shared callbacks with their remaining owner and retries failed disposal", async () => {
  const transport = resourceTransport();
  const shared = { value: () => 42 };
  let fail = true;
  const first = transport.own({ shared, ...disposable() });
  const second = transport.own({
    shared,
    dispose() {
      if (fail) {
        throw new Error("cleanup failed");
      }
    },
    async disposeAsync() {
      this.dispose();
    },
  });
  const [a, b] = transport.exchange([first, second]);
  a!.dispose();
  expect(b!.shared.value()).toBe(42);
  expect(() => b!.dispose()).toThrow("cleanup failed");
  expect(b!.shared.value()).toBe(42);
  fail = false;
  await b!.disposeAsync();
  b!.dispose();
});

it("keeps a transferred native root alive for a fork after outer recovery disposal", async () => {
  const transport = resourceTransport();
  const disposeRoot = vi.fn();
  const native = restorePluginNativeRecovery({
    receipt: { signature: "fixture", sourceDigest: "fixture" },
    references: new Map(),
    namespaces: new Map(),
    directories: new Map(),
    roots: [
      {
        directory: "/fixture/native",
        commit() {},
        dispose: disposeRoot,
        async disposeAsync() {
          disposeRoot();
        },
      },
    ],
  });
  const recovery = transport.exchange(
    transport.own({
      native,
      dispose: () => native.dispose(),
      disposeAsync: () => native.disposeAsync(),
    }),
  );
  const fork = recovery.native.fork();
  await recovery.disposeAsync();
  expect(disposeRoot).not.toHaveBeenCalled();
  const child = fork.fork();
  await child.disposeAsync();
  await fork.disposeAsync();
  expect(disposeRoot).toHaveBeenCalledTimes(1);
});

it("releases ordinary message graphs while retaining callable identity", async () => {
  const sender = new GenerationCodec(() => {
    throw new Error("unexpected callback");
  }, nativeRootTransport());
  const receiver = new GenerationCodec(
    (handle, args) => sender.call(handle, receiver.encodeArguments(args)),
    nativeRootTransport(),
  );
  const callable = receiver.decode(sender.encode((value: number) => value + 1)) as (
    value: number,
  ) => number;
  function exchange() {
    const child = { marker: "payload" };
    const payload = {
      child,
      aliases: [child, child],
      map: new Map([[child, new Set([child])]]),
      url: new URL("https://example.test/plugin"),
    };
    const cyclic = Object.assign(payload, { cycle: payload });
    const decoded = receiver.decode(sender.encode(cyclic)) as typeof cyclic;
    expect(decoded.cycle).toBe(decoded);
    expect(decoded.aliases[0]).toBe(decoded.child);
    expect(decoded.aliases[1]).toBe(decoded.child);
    expect(decoded.map.get(decoded.child)?.has(decoded.child)).toBe(true);
    expect(decoded.url.href).toBe("https://example.test/plugin");
    return weak(payload, child, decoded, decoded.child);
  }
  const references = exchange();
  await expectCollected(references);
  expect(callable(41)).toBe(42);
  const sameArgument = (first: object, second: object) => first === second;
  const compare = receiver.decode(sender.encode(sameArgument)) as typeof sameArgument;
  const argument = {};
  expect(compare(argument, argument)).toBe(true);
  expect(receiver.decode(sender.encode(sameArgument))).toBe(compare);
  expect(sender.decode(receiver.encode(compare))).toBe(sameArgument);
});

it("keeps only owner-marked source copies outside the ordinary method deadline", () => {
  const calls: boolean[] = [];
  const sender = new GenerationCodec(() => undefined, nativeRootTransport());
  const receiver = new GenerationCodec((_handle, _args, _async, sourceCapture) => {
    calls.push(sourceCapture);
  }, nativeRootTransport());
  const ownerCopy = markPluginSourceCaptureOperation(() => undefined);
  const original = {
    captureRecoverySource: ownerCopy,
    fork: () => undefined,
  };
  const decoded = receiver.decode(sender.encode(original)) as typeof original;
  decoded.captureRecoverySource();
  decoded.fork();
  expect(calls).toEqual([true, false]);
});
