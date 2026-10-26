import { describe, expect, it } from "vitest";
import {
  createSessionRowDeltaDiffer,
  prepareSessionRowDeltaFields,
} from "./session-row-delta-fields.js";

describe("session row field deltas", () => {
  it("preserves JSON values and removes fields that disappear from the wire", () => {
    const previous = {
      key: "agent:main:child",
      removed: "old",
      nowUndefined: "old",
      nil: "old",
      enabled: true,
      runtimeMs: 123,
      runs: ["old"],
    };
    const current = {
      key: "agent:main:child",
      nowUndefined: undefined,
      nil: null,
      enabled: false,
      runtimeMs: 0,
      runs: [],
      added: "new",
    };
    const delta = createSessionRowDeltaDiffer()(
      prepareSessionRowDeltaFields(previous),
      prepareSessionRowDeltaFields(current),
      current,
    );
    expect(delta).toEqual({
      set: { nil: null, enabled: false, runtimeMs: 0, runs: [], added: "new" },
      remove: ["removed", "nowUndefined"],
    });
  });

  it("compares primitive JSON values without confusing numeric normalization or strings", () => {
    const previous = {
      zero: -0,
      notANumber: Number.NaN,
      positiveInfinity: Infinity,
      negativeInfinity: -Infinity,
      nil: null,
      count: 1,
      enabled: true,
    };
    const current = {
      zero: 0,
      notANumber: null,
      positiveInfinity: null,
      negativeInfinity: null,
      nil: Number.NaN,
      count: "1",
      enabled: "true",
    };
    expect(
      createSessionRowDeltaDiffer()(
        prepareSessionRowDeltaFields(previous),
        prepareSessionRowDeltaFields(current),
        current,
      ),
    ).toEqual({ set: { count: "1", enabled: "true" }, remove: [] });
  });

  it("compares nested JSON semantically and replaces a changed nested field whole", () => {
    const previous = {
      activity: { b: [null, { done: false }], a: 1 },
      usage: { input: 4, output: 3 },
    };
    const current = {
      activity: { a: 1, b: [undefined, { done: false, ignored: undefined }] },
      usage: { input: 4, output: 5 },
    };
    expect(
      createSessionRowDeltaDiffer()(
        prepareSessionRowDeltaFields(previous),
        prepareSessionRowDeltaFields(current),
        current,
      ),
    ).toEqual({ set: { usage: { input: 4, output: 5 } }, remove: [] });
  });

  it("recomputes mutable children shared by distinct shallow-frozen row snapshots", () => {
    const usage = { input: 4, output: 3 };
    const previous = prepareSessionRowDeltaFields(Object.freeze({ usage }));
    usage.output = 5;
    const current = Object.freeze({ usage });
    expect(
      createSessionRowDeltaDiffer()(previous, prepareSessionRowDeltaFields(current), current),
    ).toEqual({ set: { usage: { input: 4, output: 5 } }, remove: [] });
  });

  it("prepares each immutable row once and reuses comparisons across interleaved recipients", () => {
    let reads = 0;
    const current = Object.freeze({
      key: "agent:main:child",
      get runtimeMs() {
        reads += 1;
        return 50;
      },
    });
    const first = prepareSessionRowDeltaFields({ key: "agent:main:child", runtimeMs: 10 });
    const second = prepareSessionRowDeltaFields({ key: "agent:main:child", runtimeMs: 50 });
    const next = prepareSessionRowDeltaFields(current);
    prepareSessionRowDeltaFields(current);
    expect(reads).toBe(1);

    const diff = createSessionRowDeltaDiffer();
    expect(diff(first, next, current)).toEqual({ set: { runtimeMs: 50 }, remove: [] });
    expect(diff(second, next, current)).toEqual({ set: {}, remove: [] });
    expect(diff(first, next, current)).toEqual({ set: { runtimeMs: 50 }, remove: [] });
    expect(reads).toBe(2);
  });
});
