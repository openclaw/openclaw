import { beforeEach, describe, expect, it, vi } from "vitest";

type ReadlineMock = {
  default: {
    createInterface: () => {
      question: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
  };
};

type PromptModule = typeof import("./prompt.js");
type GlobalsModule = typeof import("../globals.js");

let promptYesNo: PromptModule["promptYesNo"];
let readline: ReadlineMock;
let isYes: GlobalsModule["isYes"];
let setVerbose: GlobalsModule["setVerbose"];
let setYes: GlobalsModule["setYes"];

beforeEach(async () => {
  vi.resetModules();
  vi.doMock("node:readline/promises", () => {
    const question = vi.fn(async () => "");
    const close = vi.fn();
    const createInterface = vi.fn(() => ({ question, close }));
    return { default: { createInterface } };
  });
  ({ promptYesNo } = await import("./prompt.js"));
  ({ isYes, setVerbose, setYes } = await import("../globals.js"));
  readline = (await import("node:readline/promises")) as unknown as ReadlineMock;
});

describe("promptYesNo", () => {
  it("returns true when global --yes is set", async () => {
    setYes(true);
    setVerbose(false);
    const result = await promptYesNo("Continue?");
    expect(result).toBe(true);
    expect(isYes()).toBe(true);
  });

  it("asks the question and respects default", async () => {
    setYes(false);
    setVerbose(false);
    const { question: questionMock } = readline.default.createInterface();
    questionMock.mockResolvedValueOnce("");
    const resultDefaultYes = await promptYesNo("Continue?", true);
    expect(resultDefaultYes).toBe(true);

    questionMock.mockResolvedValueOnce("n");
    const resultNo = await promptYesNo("Continue?", true);
    expect(resultNo).toBe(false);

    questionMock.mockResolvedValueOnce("y");
    const resultYes = await promptYesNo("Continue?", false);
    expect(resultYes).toBe(true);
  });
});
