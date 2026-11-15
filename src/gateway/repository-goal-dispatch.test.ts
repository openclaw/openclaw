import { describe, expect, it } from "vitest";
import {
  captureRepositoryGoalDispatch,
  withRepositoryChatDispatch,
} from "./repository-dispatch.js";

const identity = {
  agentId: "main",
  sessionKey: "agent:main:goal",
  sessionId: "session-1",
  runId: "followup-1",
};

describe("Repository Goal dispatch scope", () => {
  it("creates a new bounded scope from current retained source after the input scope closes", async () => {
    let originalActive = true;
    let current = true;
    const renew = await withRepositoryChatDispatch(
      {
        ...identity,
        client: null,
        getSessionId: () => identity.sessionId,
        assertCurrent: () => {
          if (!originalActive) {
            throw new Error("input released");
          }
        },
      },
      async () =>
        captureRepositoryGoalDispatch(() => {
          if (!current) {
            throw new Error("revoked");
          }
        }),
    );
    originalActive = false;
    expect(renew).toBeDefined();
    const nested = await renew!(identity, async () =>
      captureRepositoryGoalDispatch(() => {
        if (!current) {
          throw new Error("revoked");
        }
      }),
    );
    expect(nested).toBeDefined();
    await expect(
      renew!({ ...identity, sessionId: "replacement" }, async () =>
        captureRepositoryGoalDispatch(() => {}),
      ),
    ).rejects.toThrow("session changed");
    current = false;
    await expect(
      renew!(identity, async () => captureRepositoryGoalDispatch(() => {})),
    ).rejects.toThrow("revoked");
    await expect(
      nested!(identity, async () => captureRepositoryGoalDispatch(() => {})),
    ).rejects.toThrow("revoked");
  });

  it("cannot create a Goal source outside an authenticated input dispatch", () => {
    expect(captureRepositoryGoalDispatch(() => {})).toBeUndefined();
  });
});
