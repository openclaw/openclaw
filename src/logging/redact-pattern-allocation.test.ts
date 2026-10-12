import { expect, it, vi } from "vitest";
import { redactModelVisibleSecrets, redactSensitiveText } from "./redact.js";

it("reuses matchers across distinct tool-result and diagnostic values", () => {
  const redact = (index: number) => {
    const secret = `fixtureonlyvalue${index.toString().padStart(4, "0")}`;
    return {
      result: redactModelVisibleSecrets({ content: [{ type: "text", text: `ghp_${secret}` }] }),
      diagnostic: redactSensitiveText(`API_TOKEN=${secret}\npass: ${secret}`, { mode: "tools" }),
    };
  };
  redact(0);
  let constructed = 0;
  // Preserve native instanceof behavior while counting allocations at the public entry points.
  vi.stubGlobal(
    "RegExp",
    new Proxy(RegExp, {
      construct(target, args) {
        constructed++;
        return Reflect.construct(target, args);
      },
    }),
  );
  try {
    for (let index = 0; index < 500; index++) {
      const suffix = index.toString().padStart(4, "0");
      expect(redact(index)).toEqual({
        result: { content: [{ type: "text", text: `ghp_fi…${suffix}` }] },
        diagnostic: `API_TOKEN=fixtur…${suffix}\npass: fixtur…${suffix}`,
      });
    }
    expect(constructed).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});
