import { describe, expect, it } from "vitest";
import {
  hasSessionQuestionCustodyRetiredError,
  SessionQuestionCustodyRetiredError,
} from "./session-questions-custody-error.js";

describe("question custody retired error ownership", () => {
  it("recognizes native closed cause and aggregate envelopes", () => {
    const retired = new SessionQuestionCustodyRetiredError("retired");
    const nested = new Error("wrapper", { cause: retired });
    expect(hasSessionQuestionCustodyRetiredError(new AggregateError([nested], "cleanup"))).toBe(
      true,
    );
    expect(hasSessionQuestionCustodyRetiredError(new Error("ordinary"))).toBe(false);
  });
  it("never invokes hostile getters or proxy traps", () => {
    const unsafe = () => {
      throw new Error("Getter or proxy invoked");
    };
    const ordinary = new Error("ordinary");
    Object.defineProperties(ordinary, { code: { get: unsafe }, cause: { get: unsafe } });
    expect(hasSessionQuestionCustodyRetiredError(ordinary)).toBe(false);
    expect(
      hasSessionQuestionCustodyRetiredError(
        new Proxy(ordinary, { getOwnPropertyDescriptor: unsafe, getPrototypeOf: unsafe }),
      ),
    ).toBe(false);
    const aggregate = new AggregateError([], "aggregate");
    Object.defineProperty(aggregate, "errors", { get: unsafe });
    expect(hasSessionQuestionCustodyRetiredError(aggregate)).toBe(false);
  });
});
