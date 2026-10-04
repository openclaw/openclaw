import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  config,
  params,
  PROFILE,
  request,
  sessionEntry,
  setup,
} from "./inference-runtime.test-support.js";

describe("worker inference session admission", () => {
  it("uses the admitted source when current config routes the session to another store", async () => {
    const runtime = setup();
    const changedConfig = { ...config, session: { store: "replacement-sessions.json" } };

    await expect(
      runtime.executor(params(request(), vi.fn(), changedConfig)),
    ).resolves.toMatchObject({ type: "done" });
    expect(runtime.scope.authProfile).toBe(PROFILE);
    expect(runtime.readSessionEntry).toHaveBeenCalledOnce();
    expect(runtime.stream).toHaveBeenCalledOnce();
  });

  it.each([undefined, { ...sessionEntry, sessionId: "replaced-session" }])(
    "rejects a missing or replaced session before model preparation",
    async (entry) => {
      const runtime = setup();
      runtime.readSessionEntry.mockResolvedValue(entry);

      await expect(runtime.executor(params(request(), vi.fn()))).resolves.toMatchObject({
        type: "error",
        reason: "session-not-attached",
      });
      expect(runtime.readSessionEntry).toHaveBeenCalledOnce();
      expect(runtime.acquireRuntimeLease).not.toHaveBeenCalled();
      expect(runtime.stream).not.toHaveBeenCalled();
    },
  );

  it("rejects revoked authority after an asynchronous session read", async () => {
    const runtime = setup();
    const read = createDeferred<typeof sessionEntry>();
    runtime.readSessionEntry.mockReturnValue(read.promise);
    let current = true;
    const execution = params(request(), vi.fn());
    execution.isCurrent = () => current;
    const pending = runtime.executor(execution);
    current = false;
    read.resolve(sessionEntry);

    await expect(pending).rejects.toThrow("Worker inference source is no longer current");
    expect(runtime.readSessionEntry).toHaveBeenCalledOnce();
    expect(runtime.acquireRuntimeLease).not.toHaveBeenCalled();
    expect(runtime.stream).not.toHaveBeenCalled();
  });
});
