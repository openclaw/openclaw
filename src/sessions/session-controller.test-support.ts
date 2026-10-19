import "./session-controller.js";

type SessionControllerTestApi = { resetSessionControllerForTest(): void };

export const testing = {
  resetSessionControllerForTest(): void {
    const api = (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.sessionControllerTestApi")
    ] as SessionControllerTestApi | undefined;
    if (!api) {
      throw new Error("session controller test API is unavailable");
    }
    api.resetSessionControllerForTest();
  },
};
