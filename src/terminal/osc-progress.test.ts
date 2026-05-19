import { describe, expect, it } from "vitest";
import { createOscProgressController, supportsOscProgress } from "./osc-progress.js";

describe("OSC progress", () => {
  it("detects supported terminal environments", () => {
    expect(supportsOscProgress({ TERM_PROGRAM: "WezTerm" }, true)).toBe(true);
    expect(supportsOscProgress({ TERM_PROGRAM: "Apple_Terminal" }, true)).toBe(false);
    expect(supportsOscProgress({ WT_SESSION: "1" }, false)).toBe(false);
  });

  it("writes sanitized OSC 9;4 progress sequences", () => {
    const writes: string[] = [];
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const c1StringTerminator = String.fromCharCode(0x9c);
    const controller = createOscProgressController({
      env: { TERM_PROGRAM: "ghostty" },
      isTty: true,
      write: (chunk) => writes.push(chunk),
    });

    controller.setIndeterminate("Build\u001b]bad\u0007");
    controller.setIndeterminate(`Build${esc}\\safe${c1StringTerminator}${esc}]bad${bel}]done`);
    controller.setPercent("Build", 42.6);
    controller.clear();

    expect(writes).toEqual([
      "\u001b]9;4;3;;Buildbad\u001b\\",
      "\u001b]9;4;3;;Buildsafebaddone\u001b\\",
      "\u001b]9;4;1;43;Build\u001b\\",
      "\u001b]9;4;0;0;Build\u001b\\",
    ]);
  });
});
