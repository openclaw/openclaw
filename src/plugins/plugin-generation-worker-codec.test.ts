import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it } from "vitest";
import { markPluginSourceCaptureOperation } from "./plugin-generation-source-lookup.js";
import { GenerationCodec } from "./plugin-generation-worker-codec.js";

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
