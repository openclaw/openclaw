import type { SessionCompanionAskDeps } from "./session-companion-ask.js";
import "./session-companion-ask.js";

type SessionCompanionAskTestApi = {
  defaultRun: NonNullable<SessionCompanionAskDeps["run"]>;
};

export const testing = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.sessionCompanionAskTestApi")
] as SessionCompanionAskTestApi;
