import { expect, it } from "vitest";
import { cloneTranscriptView } from "./transcript-snapshot.js";

it.each([true, false])(
  "preserves own symbol data and descriptors (sharing=%s)",
  (shareImmutablePayloads) => {
    const prelude = Symbol.for("openclaw.sessionHistoryPrelude");
    const identity = Symbol.for("openclaw.steeringMessageIdentity");
    const cutoff = Symbol.for("openclaw.memory.sessionResetRecallCutoff");
    const context = Symbol.for("openclaw.steeringRuntimeContext");
    const message = { role: "user", content: "retained" };
    const messages: [typeof message] = [message];
    Object.defineProperty(message, prelude, { value: true, configurable: true });
    Object.defineProperty(message, identity, { value: "steering-id", configurable: true });
    Object.defineProperty(message, context, {
      value: messages,
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(messages, context, { value: message, writable: true });
    Object.defineProperty(message, cutoff, { value: { state: "valid", cutoffLine: 3 } });
    Object.defineProperty(message, "hidden", { value: "not copied" });

    const cloned = cloneTranscriptView(messages, { shareImmutablePayloads });
    expect(cloned).not.toBe(messages);
    expect(cloned[0]).not.toBe(message);
    for (const marker of [prelude, identity]) {
      expect(Object.getOwnPropertyDescriptor(cloned[0], marker)).toEqual(
        Object.getOwnPropertyDescriptor(message, marker),
      );
    }
    expect(Object.getOwnPropertyDescriptor(cloned[0], context)).toEqual({
      value: cloned,
      enumerable: true,
      configurable: true,
      writable: false,
    });
    expect(Object.getOwnPropertyDescriptor(cloned, context)).toEqual({
      value: cloned[0],
      enumerable: false,
      configurable: false,
      writable: true,
    });
    expect(Object.getOwnPropertyDescriptor(cloned[0], cutoff)).toEqual({
      value: { state: "valid", cutoffLine: 3 },
      enumerable: false,
      configurable: false,
      writable: false,
    });
    expect(Reflect.get(cloned[0], cutoff)).not.toBe(Reflect.get(message, cutoff));
    expect(Object.hasOwn(cloned[0], "hidden")).toBe(false);
    expect(JSON.stringify(cloned)).toBe(JSON.stringify(messages));
  },
);
