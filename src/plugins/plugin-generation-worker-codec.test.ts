import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it, vi } from "vitest";
import { markPluginSourceCaptureOperation } from "./plugin-generation-source-lookup.js";
import { GenerationCodec } from "./plugin-generation-worker-codec.js";
import { restorePluginNativeRecovery } from "./plugin-native-admission.js";

function resourceTransport() {
  const sender = new GenerationCodec(
    () => undefined,
    (root) => own(root),
  );
  const accept = (value: unknown) => {
    const encoded = sender.encode(value);
    receiver.releaseReceivedHandles(sender.takeReleasedHandles());
    return receiver.decode(encoded);
  };
  const receiver = new GenerationCodec(
    (handle, args, asynchronous) => {
      try {
        const result = sender.call(handle, receiver.encodeArguments(args));
        return asynchronous ? Promise.resolve(result).then(accept) : accept(result);
      } catch (error) {
        receiver.releaseReceivedHandles(sender.takeReleasedHandles());
        throw error;
      }
    },
    () => undefined,
  );
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
    const parent = transport.exchange(
      transport.own({
        value: () => 42,
        dispose() {},
        async disposeAsync() {},
      }),
    );
    async function recovery() {
      const payload = { value: "captured source" };
      const original = transport.own({
        sourceCapture: { read: () => payload },
        fork: () => payload,
        dispose() {},
        async disposeAsync() {},
      });
      const decoded = transport.exchange(original);
      expect(decoded.sourceCapture.read()).toEqual(payload);
      const references = [
        new WeakRef(original),
        new WeakRef(payload),
        new WeakRef(decoded.fork),
        new WeakRef(decoded.sourceCapture.read),
      ];
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
    const control = new WeakRef({});
    await nextTurn();
    queryObjects(WeakRef);
    expect(control.deref()).toBeUndefined();
    expect(references.every((reference) => reference.deref() === undefined)).toBe(true);
    expect(parent.value()).toBe(42);
    await recovery();
    await parent.disposeAsync();
  },
);

it("keeps shared callbacks with their remaining owner and retries failed disposal", async () => {
  const transport = resourceTransport();
  const shared = { value: () => 42 };
  let fail = true;
  const first = transport.own({ shared, dispose() {}, async disposeAsync() {} });
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
  const sender = new GenerationCodec(
    () => {
      throw new Error("unexpected callback");
    },
    () => {},
  );
  const receiver = new GenerationCodec(
    (handle, args) => sender.call(handle, receiver.encodeArguments(args)),
    () => {},
  );
  const callable = receiver.decode(sender.encode((value: number) => value + 1)) as (
    value: number,
  ) => number;
  function exchange() {
    const child = { marker: "payload" };
    const payload: {
      child: object;
      aliases: object[];
      map: Map<object, Set<object>>;
      url: URL;
      cycle?: unknown;
    } = {
      child,
      aliases: [child, child],
      map: new Map([[child, new Set([child])]]),
      url: new URL("https://example.test/plugin"),
    };
    payload.cycle = payload;
    const decoded = receiver.decode(sender.encode(payload)) as typeof payload;
    expect(decoded.cycle).toBe(decoded);
    expect(decoded.aliases[0]).toBe(decoded.child);
    expect(decoded.aliases[1]).toBe(decoded.child);
    expect(decoded.map.get(decoded.child)?.has(decoded.child)).toBe(true);
    expect(decoded.url.href).toBe("https://example.test/plugin");
    return [
      new WeakRef(payload),
      new WeakRef(child),
      new WeakRef(decoded),
      new WeakRef(decoded.child),
    ];
  }
  const references = exchange();
  const control = new WeakRef({});
  await nextTurn();
  queryObjects(WeakRef);
  expect(control.deref()).toBeUndefined();
  expect(references.map((reference) => reference.deref())).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
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
  const sender = new GenerationCodec(
    () => undefined,
    () => {},
  );
  const receiver = new GenerationCodec(
    (_handle, _args, _async, sourceCapture) => {
      calls.push(sourceCapture);
    },
    () => {},
  );
  const ownerCopy = markPluginSourceCaptureOperation(() => undefined);
  const original = {
    captureRecoverySource: ownerCopy,
    retainSourceCustody: ownerCopy,
    recovery: { fork: ownerCopy },
    fork: () => undefined,
    resolve: () => undefined,
  };
  const decoded = receiver.decode(sender.encode(original)) as typeof original;
  decoded.captureRecoverySource();
  decoded.retainSourceCustody();
  decoded.recovery.fork();
  decoded.fork();
  decoded.resolve();
  expect(calls).toEqual([true, true, true, false, false]);
  expect(decoded.captureRecoverySource).toBe(decoded.recovery.fork);
});
