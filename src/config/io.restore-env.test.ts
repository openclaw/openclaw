// Verifies process.env is restored after invalid config rejection.
import { describe, expect, it } from "vitest";
import { restoreEnvChangesIfUnchanged } from "./io.js";

describe("restoreEnvChangesIfUnchanged", () => {
  it("deletes keys added after the before snapshot", () => {
    const env: Record<string, string | undefined> = { EXISTING: "keep" };
    const before = { EXISTING: "keep" };
    env.LEAKED = "should-be-deleted";
    const after = { EXISTING: "keep", LEAKED: "should-be-deleted" };

    restoreEnvChangesIfUnchanged({
      env: env as NodeJS.ProcessEnv,
      before,
      after,
    });

    expect(env.EXISTING).toBe("keep");
    expect(env.LEAKED).toBeUndefined();
    expect("LEAKED" in env).toBe(false);
  });

  it("preserves keys that already existed before", () => {
    const env: Record<string, string | undefined> = { KEEP_ME: "original" };
    const before = { KEEP_ME: "original" };
    const after = { KEEP_ME: "original" };

    restoreEnvChangesIfUnchanged({
      env: env as NodeJS.ProcessEnv,
      before,
      after,
    });

    expect(env.KEEP_ME).toBe("original");
  });

  it("restores a key to its before value when it was changed", () => {
    const env: Record<string, string | undefined> = { CHANGED: "new-value" };
    const before = { CHANGED: "old-value" };
    const after = { CHANGED: "new-value" };

    restoreEnvChangesIfUnchanged({
      env: env as NodeJS.ProcessEnv,
      before,
      after,
    });

    expect(env.CHANGED).toBe("old-value");
  });

  it("does not touch keys that diverged from after snapshot (externally modified)", () => {
    // If something else also wrote to the env between snapshot and restore,
    // we must not overwrite it — it's not our change.
    const env: Record<string, string | undefined> = {
      OURS: "added-by-config",
      EXTERNAL: "added-by-someone-else",
    };
    const before: Record<string, string | undefined> = {};
    const after: Record<string, string | undefined> = { OURS: "added-by-config" };

    restoreEnvChangesIfUnchanged({
      env: env as NodeJS.ProcessEnv,
      before,
      after,
    });

    expect(env.OURS).toBeUndefined();
    // EXTERNAL was not in after; it was added outside config load — keep it.
    expect(env.EXTERNAL).toBe("added-by-someone-else");
  });

  it("handles empty before snapshot (clean start)", () => {
    const env: Record<string, string | undefined> = { ADDED1: "a", ADDED2: "b" };
    const before: Record<string, string | undefined> = {};
    const after = { ADDED1: "a", ADDED2: "b" };

    restoreEnvChangesIfUnchanged({
      env: env as NodeJS.ProcessEnv,
      before,
      after,
    });

    expect(env.ADDED1).toBeUndefined();
    expect(env.ADDED2).toBeUndefined();
  });
});
