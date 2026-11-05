import { describe } from "vitest";
import {
  registerLegacyDriverTests,
  registerLegacyHeartbeatDriverTests,
} from "./doctor-config-preflight.legacy-driver.test-support.js";

const describeLive = process.env.OPENCLAW_LIVE_TEST === "1" ? describe : describe.skip;

describeLive("Doctor legacy updater process proofs", () => {
  registerLegacyDriverTests(["valid", "valid managed v1", "valid managed pnpm"]);
  registerLegacyHeartbeatDriverTests();
});
