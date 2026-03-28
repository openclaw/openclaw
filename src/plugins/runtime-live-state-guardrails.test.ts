import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const LIVE_RUNTIME_STATE_GUARDS: Record<
  string,
  {
    required: readonly string[];
    forbidden: readonly string[];
  }
> = {
  "extensions/whatsapp/src/active-listener.ts": {
    required: ["globalThis", 'Symbol.for("openclaw.whatsapp.activeListenerState")'],
    forbidden: ["resolveGlobalSingleton"],
  },
};

describe("runtime live state guardrails", () => {
  it("keeps split-runtime state holders on explicit direct globals", () => {
    for (const [relativePath, guard] of Object.entries(LIVE_RUNTIME_STATE_GUARDS)) {
      const source = readFileSync(resolve(repoRoot, relativePath), "utf8");

      const assertions = [
        ...guard.required.map((needle) => ({
          type: "required" as const,
          needle,
          message: `${relativePath} missing ${needle}`,
        })),
        ...guard.forbidden.map((needle) => ({
          type: "forbidden" as const,
          needle,
          message: `${relativePath} must not contain ${needle}`,
        })),
      ];

      for (const assertion of assertions) {
        if (assertion.type === "required") {
          expect(source, assertion.message).toContain(assertion.needle);
        } else {
          expect(source, assertion.message).not.toContain(assertion.needle);
        }
      }
    }
  });
});
